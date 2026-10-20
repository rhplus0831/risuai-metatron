import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxHost } from "./factory";

// `SandboxHost.startup` (safe boot, RisuNest small wins S1, `plugins-mcp.md`): how the guest's start
// ended. `ready` on `SCRIPT_SETTLED`, `failed` on `SCRIPT_SETTLED` with `failed: true` (the script
// threw or never ran), `stopped` when terminated before either; the first answer stays. A started
// guest with open work is still `ready`, and a failed one is still idle. The guest is simulated: its
// messages arrive as window messages from the iframe's window.

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => (resolve = res));
    return { promise, resolve };
}

let guestWindow: { postMessage: (data: any, origin: string, ports?: MessagePort[]) => void };
let posted: unknown[];
let host: SandboxHost;
const api: Record<string, (...args: any[]) => unknown> = {};

const send = (data: unknown) => {
    window.dispatchEvent(new MessageEvent("message", { data, source: guestWindow as unknown as Window }));
};
/** Whether `promise` is still pending after the queued microtasks ran. */
const pending = (promise: Promise<unknown>) =>
    Promise.race([promise.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0))]);

beforeEach(() => {
    posted = [];
    guestWindow = {
        postMessage(data) {
            posted.push(data);
        },
    };
    vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockImplementation(() => guestWindow as any);
    vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (const key of Object.keys(api)) delete api[key];
    host = new SandboxHost(api);
    host.run(document.createElement("iframe"), "");
});

afterEach(() => {
    host.terminate();
    vi.restoreAllMocks();
});

describe("SandboxHost.startup", () => {
    it("is pending until the guest reports, then ready", async () => {
        expect(await pending(host.startup)).toBe(true);
        send({ type: "SCRIPT_SETTLED" });
        await expect(host.startup).resolves.toBe("ready");
        expect(host.isIdle()).toBe(true);
    });

    it("is failed when the guest reports a failed start, which still settles the script for idleness", async () => {
        send({ type: "SCRIPT_SETTLED", failed: true });
        await expect(host.startup).resolves.toBe("failed");
        expect(host.isIdle()).toBe(true);
    });

    it("is stopped when terminated before the guest reported", async () => {
        host.terminate();
        await expect(host.startup).resolves.toBe("stopped");
    });

    it("keeps the guest's answer once given: ready survives a later terminate, failed a later settle", async () => {
        send({ type: "SCRIPT_SETTLED" });
        host.terminate();
        await expect(host.startup).resolves.toBe("ready");

        const failed = new SandboxHost(api);
        failed.run(document.createElement("iframe"), "");
        send({ type: "SCRIPT_SETTLED", failed: true });
        send({ type: "SCRIPT_SETTLED" });
        await expect(failed.startup).resolves.toBe("failed");
        failed.terminate();
    });

    it("is ready for a started guest whose host call is still open (not idle)", async () => {
        const headers = deferred<string>();
        api.nativeFetch = () => headers.promise;
        send({ type: "CALL_ROOT", reqId: "fetch", method: "nativeFetch", args: ["https://example.test/"] });
        send({ type: "SCRIPT_SETTLED" });
        expect(host.isIdle()).toBe(false);
        await expect(host.startup).resolves.toBe("ready");
        headers.resolve("answer");
        await vi.waitFor(() => expect(posted.at(-1)).toMatchObject({ type: "RESPONSE", reqId: "fetch" }));
    });
});
