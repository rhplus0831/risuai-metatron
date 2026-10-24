// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxHost } from "./factory";

// The guest half of the sandbox RPC (`GUEST_BRIDGE_SCRIPT`) as the iframe runs it: taken from the
// srcdoc `SandboxHost.run` writes, then evaluated over a fake window. Node's own `ReadableStream`,
// `Response`, and `MessageChannel` stand in for the iframe's. The srcdoc carries two scripts: the
// main one (the bridge, then the plugin's code, reporting `SCRIPT_SETTLED` once both settled) and a
// fallback that reports it when the main one never ran (a syntax error).

function guestScripts(userCode = ""): { main: string; fallback: string } {
    let html = "";
    class FakeIframe {
        style = {};
        sandbox = { add() {} };
        contentWindow = null;
        setAttribute() {}
        remove() {}
        set srcdoc(value: string) {
            html = value;
        }
    }
    vi.stubGlobal("HTMLIFrameElement", FakeIframe);
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
    try {
        const host = new SandboxHost({});
        host.run(new FakeIframe() as unknown as HTMLIFrameElement, userCode);
        host.terminate();
    } finally {
        vi.unstubAllGlobals();
    }
    const scripts = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((match) => match[1]);
    if (scripts.length !== 2) throw new Error(`expected two guest scripts in the srcdoc, found ${scripts.length}`);
    return { main: scripts[0], fallback: scripts[1] };
}

type HostMessage = {
    type: string;
    reqId: string;
    method?: string;
    args?: unknown[];
    result?: unknown;
    error?: string;
};

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

/**
 * Runs the main script. The srcdoc rethrows a failed plugin script on purpose (the iframe's console
 * shows it); with `throws`, the promise that rethrow rejects gets a handler here, since Node would
 * otherwise report it as an unhandled rejection. The script's own `.then` runs synchronously at
 * evaluation, so the patch is in place only for that call.
 */
function evaluateMain(main: string, guestWindow: Record<string, any>, throws: boolean) {
    const run = () => new Function("window", "document", main)(guestWindow, { querySelector: () => null });
    if (!throws) return run();
    const originalThen = Promise.prototype.then;
    Promise.prototype.then = function (this: Promise<unknown>, onFulfilled?: any, onRejected?: any) {
        const chained = originalThen.call(this, onFulfilled, onRejected);
        originalThen.call(chained, undefined, () => {});
        return chained;
    } as typeof originalThen;
    try {
        run();
    } finally {
        Promise.prototype.then = originalThen;
    }
}

async function startGuest(userCode = "", options: { throws?: boolean } = {}) {
    const listeners: ((event: { data: unknown; ports: MessagePort[]; source: unknown }) => Promise<void>)[] = [];
    const calls: HostMessage[] = [];
    const posts: { message: HostMessage; ports: MessagePort[] }[] = [];
    const initialized = deferred<void>();
    // The host's messages come from the guest's parent window, as `SandboxHost` posts them.
    const deliver = (data: unknown, ports: MessagePort[] = [], source: unknown = guestWindow.parent) => {
        return Promise.all(listeners.map((listener) => listener({ data, ports, source })));
    };
    const guestWindow: Record<string, any> = {
        parent: {
            postMessage(message: HostMessage, _origin: string, transferables: Transferable[] = []) {
                calls.push(message);
                posts.push({
                    message,
                    ports: transferables.filter((value): value is MessagePort => value instanceof MessagePort),
                });
                // The bridge's start-up calls: no cached properties, no aliases.
                if (message.method === "_getPropertiesForInitialization")
                    queueMicrotask(() => deliver({ type: "RESPONSE", reqId: message.reqId, result: { list: [] } }));
                if (message.method === "_getAliases")
                    queueMicrotask(() => {
                        void deliver({ type: "RESPONSE", reqId: message.reqId, result: {} });
                        initialized.resolve();
                    });
            },
        },
        addEventListener(type: string, listener: (typeof listeners)[number]) {
            if (type === "message") listeners.push(listener);
        },
        postMessage() {},
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { main } = guestScripts(userCode);
    // Node has no ImageBitmap; the bridge's transferable scan checks for it.
    vi.stubGlobal("ImageBitmap", class {});
    evaluateMain(main, guestWindow, options.throws ?? false);
    await initialized.promise;
    return { risuai: guestWindow.risuai, calls, posts, deliver, window: guestWindow };
}

/** Register through the guest API, then invoke the callback with the host's wire-format signals. */
async function invokeProvider(
    guest: Awaited<ReturnType<typeof startGuest>>,
    callback: (...signals: AbortSignal[]) => unknown,
    abortIds: string[],
) {
    const registering = guest.risuai.addProvider("streaming provider", callback);
    const registration = guest.calls.at(-1)!;
    const ref = registration.args![1] as { __type: string; id: string };
    expect(ref.__type).toBe("CALLBACK_REF");
    await guest.deliver({ type: "RESPONSE", reqId: registration.reqId });
    await registering;
    await guest.deliver({
        type: "INVOKE_CALLBACK",
        reqId: "provider-call",
        id: ref.id,
        args: abortIds.map((abortId) => ({ __type: "ABORT_SIGNAL_REF", abortId, aborted: false })),
    });
    const response = guest.posts.find(
        ({ message }) => message.type === "CALLBACK_RETURN" && message.reqId === "provider-call",
    );
    expect(response).toBeDefined();
    return response!;
}

function pullFromGuest(port: MessagePort) {
    const next = new Promise<unknown>((resolve) => {
        port.onmessage = (event) => resolve(event.data);
    });
    port.postMessage({ pull: true });
    return next;
}

const settledReports = (calls: HostMessage[]) => calls.filter((call) => call.type === "SCRIPT_SETTLED");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("the guest bridge's message sources", () => {
    it("ignores an RPC response and its stream port from another window until the parent responds", async () => {
        const guest = await startGuest();
        const { port1: host, port2 } = new MessageChannel();
        try {
            const received: unknown[] = [];
            const marker = { marker: "after the foreign response" };
            const marked = new Promise<void>((resolve) => {
                host.onmessage = (event) => {
                    received.push(event.data);
                    if (event.data.marker === marker.marker) resolve();
                };
            });
            const fetched: Promise<Response> = guest.risuai.nativeFetch("https://example.test/body");
            let state = "pending";
            void fetched.then(
                () => {
                    state = "resolved";
                },
                () => {
                    state = "rejected";
                },
            );
            const call = guest.calls.find((message) => message.method === "nativeFetch")!;
            const response = {
                type: "RESPONSE",
                reqId: call.reqId,
                result: {
                    __type: "CALLBACK_STREAMS",
                    __specialType: "Response",
                    value: { __type: "STREAM_PORT", portIndex: 0 },
                    init: { status: 200, statusText: "OK", headers: [] },
                },
            };

            guest.deliver(response, [port2], { postMessage() {} });
            // FIFO port delivery puts any guest messages before this marker; promise reactions
            // also finish before its message event, without waiting for a wall-clock delay.
            port2.postMessage(marker);
            await marked;
            expect.soft(received).toEqual([marker]);
            expect.soft(port2.onmessage).toBeNull();
            expect(state).toBe("pending");

            guest.deliver(response, [port2]);
            const result = await fetched;
            expect(result).toBeInstanceOf(Response);
            expect(result.status).toBe(200);
            expect(result.body).toBeInstanceOf(ReadableStream);
        } finally {
            host.close();
            port2.close();
        }
    });

    it("ignores an RPC error with a null source until the parent responds", async () => {
        const guest = await startGuest();
        const fetched: Promise<Response> = guest.risuai.nativeFetch("https://example.test/body");
        let state = "pending";
        void fetched.then(
            () => {
                state = "resolved";
            },
            () => {
                state = "rejected";
            },
        );
        const call = guest.calls.find((message) => message.method === "nativeFetch")!;

        guest.deliver({ type: "RESPONSE", reqId: call.reqId, error: "forged error" }, [], null);
        // A rejected RPC promise would run its reaction before this continuation.
        await Promise.resolve();
        expect(state).toBe("pending");

        guest.deliver({
            type: "RESPONSE",
            reqId: call.reqId,
            result: {
                __type: "CALLBACK_STREAMS",
                __specialType: "Response",
                value: null,
                init: { status: 204, statusText: "No Content", headers: [] },
            },
        });
        const result = await fetched;
        expect(result).toBeInstanceOf(Response);
        expect(result.status).toBe(204);
        expect(result.body).toBeNull();
    });
});

describe("the guest bridge's reconstructed streams", () => {
    it("pulls a nativeFetch body from the host only when the plugin reads it", async () => {
        const guest = await startGuest();
        const { port1: host, port2 } = new MessageChannel();
        const received: unknown[] = [];
        // Port delivery takes real event-loop turns: each wait is a latch checked on every host message,
        // not a bounded poll.
        let onReceived = () => {};
        host.onmessage = (event) => {
            received.push(event.data);
            onReceived();
        };
        const arrived = (done: () => boolean) =>
            new Promise<void>((resolve) => {
                onReceived = () => {
                    if (done()) resolve();
                };
                onReceived();
            });
        // Everything the guest sends on its port arrives before a marker posted after it.
        const settled = async (marker: number) => {
            port2.postMessage({ marker });
            await arrived(() => received.some((message) => (message as { marker?: number }).marker === marker));
        };

        const fetched: Promise<Response> = guest.risuai.nativeFetch("https://example.test/body");
        const call = guest.calls.find((message) => message.method === "nativeFetch")!;
        guest.deliver(
            {
                type: "RESPONSE",
                reqId: call.reqId,
                result: {
                    __type: "CALLBACK_STREAMS",
                    __specialType: "Response",
                    value: { __type: "STREAM_PORT", portIndex: 0 },
                    init: { status: 200, statusText: "OK", headers: [] },
                },
            },
            [port2],
        );
        const response = await fetched;
        expect(response.status).toBe(200);

        // Unread: no pull, so the host's unread timer keeps running.
        await settled(1);
        expect(received).toEqual([{ marker: 1 }]);

        // Each read asks for one chunk.
        const reader = response.body!.getReader();
        const read = reader.read();
        await arrived(() => received.length >= 2);
        expect(received).toEqual([{ marker: 1 }, { pull: true }]);
        host.postMessage({ done: false, value: new TextEncoder().encode("chunk") });
        const chunk = await read;
        expect(new TextDecoder().decode(chunk.value)).toBe("chunk");
        await settled(2);
        expect(received).toEqual([{ marker: 1 }, { pull: true }, { marker: 2 }]);

        const end = reader.read();
        await arrived(() => received.length >= 4);
        // A surplus pull would arrive before this marker.
        await settled(3);
        expect(received).toEqual([{ marker: 1 }, { pull: true }, { marker: 2 }, { pull: true }, { marker: 3 }]);
        host.postMessage({ done: true });
        expect((await end).done).toBe(true);
        host.close();
    });
});

describe("the guest callback's abort signals", () => {
    it("forwards a host abort after the callback returned its still-open stream", async () => {
        const guest = await startGuest();
        let signal!: AbortSignal;
        const cancelled = deferred<void>();
        const response = await invokeProvider(
            guest,
            (abortSignal) => {
                signal = abortSignal;
                return new ReadableStream({
                    start: (controller) => controller.enqueue("partial response"),
                    cancel: () => cancelled.resolve(),
                });
            },
            ["request"],
        );
        expect(response.message.result).toEqual({ __type: "STREAM_PORT", portIndex: 0 });
        const [port] = response.ports;
        try {
            expect(await pullFromGuest(port)).toEqual({ done: false, value: "partial response" });
            expect(signal.aborted).toBe(false);
            await guest.deliver({ type: "ABORT_SIGNAL", abortId: "request" });
            expect(signal.aborted).toBe(true);
        } finally {
            port.postMessage({ cancel: true });
            await cancelled.promise;
            port.close();
        }
    });

    it.each(["done", "error", "host cancel"] as const)(
        "keeps signals until every returned stream finishes and releases them after %s",
        async (ending) => {
            const guest = await startGuest();
            let signals!: AbortSignal[];
            let lastController!: ReadableStreamDefaultController;
            const cancelled = deferred<void>();
            const response = await invokeProvider(
                guest,
                (...received) => {
                    signals = received;
                    return {
                        first: new ReadableStream({ start: (controller) => controller.close() }),
                        last: new ReadableStream({
                            start: (controller) => {
                                lastController = controller;
                            },
                            cancel: () => cancelled.resolve(),
                        }),
                    };
                },
                ["while-open", "after-finished", "another-after-finished"],
            );
            expect(response.ports).toHaveLength(2);
            const [first, last] = response.ports;
            let finished = false;
            try {
                expect(await pullFromGuest(first)).toEqual({ done: true });
                // One stream ended, but the other still needs the callback's signals.
                await guest.deliver({ type: "ABORT_SIGNAL", abortId: "while-open" });
                expect(signals[0].aborted).toBe(true);
                expect(signals[1].aborted).toBe(false);

                if (ending === "host cancel") {
                    last.postMessage({ cancel: true });
                    await cancelled.promise;
                } else {
                    if (ending === "done") lastController.close();
                    else lastController.error(new Error("provider stream failed"));
                    expect(await pullFromGuest(last)).toEqual(
                        ending === "done" ? { done: true } : { done: true, error: "provider stream failed" },
                    );
                }
                finished = true;
                // A late host abort must no longer reach a signal whose streams all ended.
                await guest.deliver({ type: "ABORT_SIGNAL", abortId: "after-finished" });
                expect(signals[1].aborted).toBe(false);
                await guest.deliver({ type: "ABORT_SIGNAL", abortId: "another-after-finished" });
                expect(signals[2].aborted).toBe(false);
            } finally {
                if (!finished) {
                    last.postMessage({ cancel: true });
                    await cancelled.promise;
                }
                first.close();
                last.close();
            }
        },
    );

    it.each(["returns no stream", "throws"])("releases signals immediately when the callback %s", async (outcome) => {
        const guest = await startGuest();
        let signal!: AbortSignal;
        const response = await invokeProvider(
            guest,
            (abortSignal) => {
                signal = abortSignal;
                if (outcome === "throws") throw new Error("provider failed");
                return { success: true, content: "complete response" };
            },
            ["finished-request"],
        );
        if (outcome === "throws") expect(response.message.error).toBe("provider failed");
        else expect(response.message.result).toEqual({ success: true, content: "complete response" });
        expect(response.ports).toEqual([]);
        await guest.deliver({ type: "ABORT_SIGNAL", abortId: "finished-request" });
        expect(signal.aborted).toBe(false);
    });
});

describe("the guest's start-up report", () => {
    it("posts SCRIPT_SETTLED once the bridge started and the plugin's top-level code settled", async () => {
        const guest = await startGuest("");
        await vi.waitFor(() => expect(settledReports(guest.calls)).toHaveLength(1));
        expect(settledReports(guest.calls)).toEqual([{ type: "SCRIPT_SETTLED" }]);
        expect(guest.window.__risuGuestStarted).toBe(true);
    });

    it("posts SCRIPT_SETTLED with failed when the plugin's top-level code throws", async () => {
        const guest = await startGuest("throw new Error('plugin broke');", { throws: true });
        await vi.waitFor(() => expect(settledReports(guest.calls)).toHaveLength(1));
        expect(settledReports(guest.calls)).toEqual([{ type: "SCRIPT_SETTLED", failed: true }]);
    });

    it("posts nothing while the plugin's top-level code is still pending", async () => {
        const guest = await startGuest("await new Promise(() => {});");
        await flush();
        expect(settledReports(guest.calls)).toEqual([]);
    });

    it("has the fallback script report a main script that never ran (a syntax error), and stay quiet otherwise", () => {
        const { main, fallback } = guestScripts("this is not javascript");
        expect(() => new Function("window", "document", main)).toThrow(SyntaxError);

        const reports: HostMessage[] = [];
        const parent = { postMessage: (message: HostMessage) => reports.push(message) };
        new Function("window", fallback)({ parent });
        expect(reports).toEqual([{ type: "SCRIPT_SETTLED", failed: true }]);

        new Function("window", fallback)({ parent, __risuGuestStarted: true });
        expect(reports).toHaveLength(1);
    });
});
