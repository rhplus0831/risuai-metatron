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

type HostMessage = { type: string; reqId: string; method?: string };

async function startGuest(userCode = "") {
    const listeners: ((event: { data: unknown; ports: MessagePort[] }) => void)[] = [];
    const calls: HostMessage[] = [];
    const deliver = (data: unknown, ports: MessagePort[] = []) => {
        for (const listener of listeners) listener({ data, ports });
    };
    const guestWindow: Record<string, any> = {
        parent: {
            postMessage(message: HostMessage) {
                calls.push(message);
                // The bridge's start-up calls: no cached properties, no aliases.
                if (message.method === "_getPropertiesForInitialization")
                    queueMicrotask(() => deliver({ type: "RESPONSE", reqId: message.reqId, result: { list: [] } }));
                if (message.method === "_getAliases")
                    queueMicrotask(() => deliver({ type: "RESPONSE", reqId: message.reqId, result: {} }));
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
    new Function("window", "document", main)(guestWindow, { querySelector: () => null });
    await vi.waitFor(() => expect(calls.map((call) => call.method)).toContain("_getAliases"));
    return { risuai: guestWindow.risuai, calls, deliver, window: guestWindow };
}

const settledReports = (calls: HostMessage[]) => calls.filter((call) => call.type === "SCRIPT_SETTLED");
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("the guest bridge's reconstructed streams", () => {
    it("pulls a nativeFetch body from the host only when the plugin reads it", async () => {
        const guest = await startGuest();
        const { port1: host, port2 } = new MessageChannel();
        const received: unknown[] = [];
        host.onmessage = (event) => received.push(event.data);
        // Everything the guest sends on its port arrives before a marker posted after it.
        const settled = async (marker: number) => {
            port2.postMessage({ marker });
            await vi.waitFor(() => expect(received).toContainEqual({ marker }));
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
        await vi.waitFor(() => expect(received).toEqual([{ marker: 1 }, { pull: true }]));
        host.postMessage({ done: false, value: new TextEncoder().encode("chunk") });
        const chunk = await read;
        expect(new TextDecoder().decode(chunk.value)).toBe("chunk");
        await settled(2);
        expect(received).toEqual([{ marker: 1 }, { pull: true }, { marker: 2 }]);

        const end = reader.read();
        await vi.waitFor(() =>
            expect(received).toEqual([{ marker: 1 }, { pull: true }, { marker: 2 }, { pull: true }]),
        );
        host.postMessage({ done: true });
        expect((await end).done).toBe(true);
        host.close();
    });
});

describe("the guest's start-up report", () => {
    it("posts SCRIPT_SETTLED once the bridge started and the plugin's top-level code settled", async () => {
        const guest = await startGuest("");
        await vi.waitFor(() => expect(settledReports(guest.calls)).toHaveLength(1));
        expect(guest.window.__risuGuestStarted).toBe(true);
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
        expect(reports).toEqual([{ type: "SCRIPT_SETTLED" }]);

        new Function("window", fallback)({ parent, __risuGuestStarted: true });
        expect(reports).toHaveLength(1);
    });
});
