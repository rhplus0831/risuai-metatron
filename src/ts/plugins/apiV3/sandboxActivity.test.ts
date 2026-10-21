import { MessageChannel as NodeMessageChannel, MessagePort as NodeMessagePort } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxHost } from "./factory";

// `SandboxHost` activity (`plugins-mcp.md`): `isIdle()` once the guest's
// script settled while no guest-to-host call, host-to-guest callback, or bridged stream is open, or
// once terminated; `onActivityChanged` hears each change toward idle. A callback that cannot be
// delivered, or whose result's streams cannot all be rebuilt, rejects and leaves nothing pending. The
// guest is simulated: its calls arrive as window messages from the iframe's window.

type Posted = { data: any; ports: MessagePort[] };

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let guestWindow: { postMessage: (data: any, origin: string, ports?: MessagePort[]) => void } | null;
let posted: Posted[];
let host: SandboxHost;
let changed: ReturnType<typeof vi.fn<() => void>>;
const api: Record<string, (...args: any[]) => unknown> = {};

const send = (data: unknown, ports: MessagePort[] = []) => {
    const event = new MessageEvent("message", { data, source: guestWindow as unknown as Window });
    if (ports.length > 0) Object.defineProperty(event, "ports", { value: ports });
    window.dispatchEvent(event);
};
const lastPosted = () => posted[posted.length - 1];
const settledScript = () => {
    send({ type: "SCRIPT_SETTLED" });
    expect(host.isIdle()).toBe(true);
    changed.mockClear();
};
/** The guest hands the host a callback reference; the host returns the wrapper the API received. */
async function callbackFromGuest(): Promise<(...args: unknown[]) => Promise<unknown>> {
    let wrapper!: (...args: unknown[]) => Promise<unknown>;
    api.keep = (fn: (...args: unknown[]) => Promise<unknown>) => {
        wrapper = fn;
    };
    send({ type: "CALL_ROOT", reqId: "keep", method: "keep", args: [{ __type: "CALLBACK_REF", id: "cb-1" }] });
    await vi.waitFor(() => expect(lastPosted().data).toMatchObject({ type: "RESPONSE", reqId: "keep" }));
    expect(host.isIdle()).toBe(true);
    return wrapper;
}

beforeEach(() => {
    vi.stubGlobal("MessageChannel", NodeMessageChannel);
    vi.stubGlobal("MessagePort", NodeMessagePort);
    if (typeof ImageBitmap === "undefined") vi.stubGlobal("ImageBitmap", class {});
    posted = [];
    guestWindow = {
        postMessage(data, _origin, ports = []) {
            posted.push({ data, ports });
        },
    };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockImplementation(() => guestWindow as any);
    vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const key of Object.keys(api)) delete api[key];
    host = new SandboxHost(api);
    changed = vi.fn<() => void>();
    host.onActivityChanged(changed);
    host.run(document.createElement("iframe"), "");
});

afterEach(() => {
    host.terminate();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("SandboxHost activity", () => {
    it("is busy until the guest's script settled, then idle, and tells its listener", () => {
        expect(host.isIdle()).toBe(false);
        send({ type: "SCRIPT_SETTLED" });
        expect(host.isIdle()).toBe(true);
        expect(changed).toHaveBeenCalledTimes(1);
    });

    it("is busy while a guest-to-host call runs (a nativeFetch awaiting headers)", async () => {
        settledScript();
        const headers = deferred<string>();
        api.nativeFetch = () => headers.promise;
        send({ type: "CALL_ROOT", reqId: "fetch", method: "nativeFetch", args: ["https://example.test/"] });
        expect(host.isIdle()).toBe(false);
        headers.resolve("answer");
        await vi.waitFor(() => expect(lastPosted().data).toMatchObject({ type: "RESPONSE", reqId: "fetch" }));
        expect(host.isIdle()).toBe(true);
        expect(changed).toHaveBeenCalled();
    });

    it("is busy while a host-to-guest callback awaits its answer", async () => {
        settledScript();
        const wrapper = await callbackFromGuest();
        const running = wrapper("arg");
        expect(host.isIdle()).toBe(false);
        const invoke = lastPosted().data;
        expect(invoke).toMatchObject({ type: "INVOKE_CALLBACK", id: "cb-1", args: ["arg"] });
        send({ type: "CALLBACK_RETURN", reqId: invoke.reqId, result: 42 });
        await expect(running).resolves.toBe(42);
        expect(host.isIdle()).toBe(true);
        expect(changed).toHaveBeenCalled();
    });

    it("rejects a callback it cannot deliver (no guest window) and leaves nothing pending", async () => {
        settledScript();
        const wrapper = await callbackFromGuest();
        guestWindow = null;
        await expect(wrapper("arg")).rejects.toThrow("The plugin was unloaded");
        expect(host.isIdle()).toBe(true);
        expect(changed).toHaveBeenCalled();
    });

    it("is busy while a host stream bridged to the guest is open", async () => {
        settledScript();
        api.body = async () => new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1])) }));
        send({ type: "CALL_ROOT", reqId: "body", method: "body", args: [] });
        await vi.waitFor(() => expect(lastPosted().data).toMatchObject({ type: "RESPONSE", reqId: "body" }));
        expect(lastPosted().ports).toHaveLength(1);
        expect(host.isIdle()).toBe(false);
        changed.mockClear();
        const port = lastPosted().ports[0];
        port.postMessage({ cancel: true });
        await vi.waitFor(() => expect(host.isIdle()).toBe(true));
        expect(changed).toHaveBeenCalled();
        port.close();
    });

    it("is busy while a guest stream rebuilt for the host is open", async () => {
        settledScript();
        const wrapper = await callbackFromGuest();
        const running = wrapper();
        const { port1, port2 } = new NodeMessageChannel();
        const received: unknown[] = [];
        port1.on("message", (message) => received.push(message));
        send(
            {
                type: "CALLBACK_RETURN",
                reqId: lastPosted().data.reqId,
                result: { __type: "STREAM_PORT", portIndex: 0 },
            },
            [port2 as unknown as MessagePort],
        );
        const stream = (await running) as ReadableStream;
        expect(host.isIdle()).toBe(false);
        // The host's stream pulls ahead (its high-water mark), so the read may not add a pull of its own.
        const read = stream.getReader().read();
        await vi.waitFor(() => expect(received).toContainEqual({ pull: true }));
        port1.postMessage({ done: true });
        await expect(read).resolves.toEqual({ done: true, value: undefined });
        expect(host.isIdle()).toBe(true);
        port1.close();
    });

    it("rejects a callback result whose streams cannot all be rebuilt, cancelling those built", async () => {
        settledScript();
        const wrapper = await callbackFromGuest();
        const running = wrapper();
        const { port1, port2 } = new NodeMessageChannel();
        const received: unknown[] = [];
        port1.on("message", (message) => received.push(message));
        send(
            {
                type: "CALLBACK_RETURN",
                reqId: lastPosted().data.reqId,
                result: {
                    first: { __type: "STREAM_PORT", portIndex: 0 },
                    second: { __type: "STREAM_PORT", portIndex: 7 },
                },
            },
            [port2 as unknown as MessagePort],
        );
        await expect(running).rejects.toThrow("Stream port at index 7 not received");
        expect(host.isIdle()).toBe(true);
        await vi.waitFor(() => expect(received).toEqual([{ cancel: true }]));
        port1.close();
    });

    it("is idle once terminated, after one last notification", async () => {
        settledScript();
        const wrapper = await callbackFromGuest();
        const running = wrapper();
        expect(host.isIdle()).toBe(false);
        changed.mockClear();
        host.terminate();
        await expect(running).rejects.toThrow("The plugin was unloaded");
        expect(host.isIdle()).toBe(true);
        expect(changed).toHaveBeenCalledTimes(1);
        // A callback asked of a terminated host rejects at once, without notifying the dropped listener.
        await expect(wrapper()).rejects.toThrow("The plugin was unloaded");
        expect(changed).toHaveBeenCalledTimes(1);
    });
});
