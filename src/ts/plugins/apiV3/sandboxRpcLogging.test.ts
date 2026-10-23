import { inspect } from "node:util";
import { MessageChannel as NodeMessageChannel, MessagePort as NodeMessagePort } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import * as globalApi from "src/ts/globalApi.svelte";
import { executePluginV3, loadV3Plugins } from "./v3.svelte";

type Reply = { type: string; reqId: string; error?: string; result?: unknown };
const guestPorts = new Set<MessagePort>();

afterEach(async () => {
    try {
        await loadV3Plugins([]);
    } finally {
        for (const port of guestPorts) port.close();
        guestPorts.clear();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    }
});

it("keeps nativeFetch authorization values and request bodies out of every host console method", async () => {
    vi.stubGlobal("MessageChannel", NodeMessageChannel);
    vi.stubGlobal("MessagePort", NodeMessagePort);
    if (typeof ImageBitmap === "undefined") vi.stubGlobal("ImageBitmap", class {});

    const reqId = "native-fetch-private-rpc";
    const url = "https://example.test/private-plugin-request";
    const secret = "sandbox-rpc-secret-7b590ec4";
    const body = "sandbox-rpc-private-body-98e3a76d";
    const authorization = `Bearer ${secret}`;
    let replyToGuest: (response: Reply) => void;
    const reply = new Promise<Reply>((resolve) => {
        replyToGuest = resolve;
    });
    const guest = {
        postMessage(data: Reply, _origin: string, ports: MessagePort[] = []) {
            for (const port of ports) guestPorts.add(port);
            replyToGuest(data);
        },
    } as unknown as Window;
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue(guest);
    // The simulated guest speaks the protocol directly; do not execute a second guest in happy-dom.
    vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation(() => {});
    await executePluginV3({ name: "private-native-fetch", version: "3.0", script: "" } as never);
    // A bodyless response needs no unread-stream timer or guest read to finish the RPC.
    const fetchNative = vi.spyOn(globalApi, "fetchNative").mockResolvedValue(new Response(null, { status: 204 }));

    const consoleSpies = (["log", "info", "debug", "warn", "error", "trace"] as const).map((method) => ({
        method,
        spy: vi.spyOn(console, method).mockImplementation(() => {}),
    }));
    window.dispatchEvent(
        new MessageEvent("message", {
            source: guest,
            data: {
                type: "CALL_ROOT",
                reqId,
                method: "nativeFetch",
                args: [url, { method: "POST", headers: { Authorization: authorization }, body }],
            },
        }),
    );
    const response = await reply;

    expect(fetchNative).toHaveBeenCalledExactlyOnceWith(url, expect.objectContaining({ method: "POST", body }));
    expect(new Headers(fetchNative.mock.calls[0][1]?.headers).get("Authorization")).toBe(authorization);
    expect(response).toMatchObject({ type: "RESPONSE", reqId });
    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();

    for (const { method, spy } of consoleSpies) {
        for (const args of spy.mock.calls) {
            for (const arg of args) {
                const output = inspect(arg, { depth: Infinity, maxArrayLength: Infinity, maxStringLength: Infinity });
                expect.soft(output, `console.${method} must not expose the authorization secret`).not.toContain(secret);
                expect.soft(output, `console.${method} must not expose the request body`).not.toContain(body);
            }
        }
    }
});
