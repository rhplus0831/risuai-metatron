// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxHost } from "./factory";

// The guest half of the sandbox RPC (`GUEST_BRIDGE_SCRIPT`) as the iframe runs it: taken from the
// srcdoc `SandboxHost.run` writes, then evaluated over a fake window. Node's own `ReadableStream`,
// `Response`, and `MessageChannel` stand in for the iframe's.

function guestScript(): string {
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
        host.run(new FakeIframe() as unknown as HTMLIFrameElement, "");
        host.terminate();
    } finally {
        vi.unstubAllGlobals();
    }
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)?.[1];
    if (!script) throw new Error("no guest script in the srcdoc");
    return script;
}

type HostMessage = { type: string; reqId: string; method?: string };

async function startGuest() {
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
    const script = guestScript();
    // Node has no ImageBitmap; the bridge's transferable scan checks for it.
    vi.stubGlobal("ImageBitmap", class {});
    new Function("window", "document", script)(guestWindow, { querySelector: () => null });
    await vi.waitFor(() => expect(calls.map((call) => call.method)).toContain("_getAliases"));
    return { risuai: guestWindow.risuai, calls, deliver };
}

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
