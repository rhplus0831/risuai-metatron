import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/ts/alert", async () => (await import("src/ts/tests/alertMock")).createAlertMock());

import { settings } from "src/ts/storage/settingsViews.svelte";
import { installFlatDatabase } from "src/ts/storage/tests/installFlatDatabase";
import { databaseAccessRecorderScript } from "./developMode";
import { SandboxHost } from "./factory";
import { executePluginV3, loadV3Plugins } from "./v3.svelte";
import type { RisuPlugin } from "../../../../shared/plugins.ts";

const pluginName = "Database reader";
const databaseFixture = () => ({
    username: "private-username",
    temperature: 791.125,
    characters: [
        { name: "private-name-a", chats: [{ message: "private-chat-a" }] },
        { name: "private-name-b", chats: [{ message: "private-chat-b" }] },
        { name: "private-name-c", chats: [{ message: "private-chat-c" }] },
    ],
});

type DatabaseResult = ReturnType<typeof databaseFixture>;
type WireMessage = { type: string; reqId?: string; method?: string; args?: unknown[]; failed?: boolean };
type GuestApi = {
    getDatabase(includeOnly?: string[]): Promise<DatabaseResult>;
    setDatabase(value: DatabaseResult): Promise<unknown>;
    nativeFetch(url: string): Promise<unknown>;
    apiVersion: string;
    pluginStorage: {
        setItem(key: string, value: unknown): Promise<unknown>;
        getItem(key: string): Promise<unknown>;
    };
};

let srcdocs: string[];

beforeEach(() => {
    srcdocs = [];
    // Execute the captured guest ourselves, without happy-dom loading another iframe document.
    vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation((html) => srcdocs.push(html));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    if (typeof ImageBitmap === "undefined") vi.stubGlobal("ImageBitmap", class {});
});

afterEach(async () => {
    await loadV3Plugins([]);
    document.body.replaceChildren();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function sandboxHtml(userCode = "", options?: { guestPrelude?: string }) {
    const host = new SandboxHost({});
    try {
        host.run(document.createElement("iframe"), userCode, options);
        return srcdocs.at(-1)!;
    } finally {
        host.terminate();
    }
}

/** The real srcdoc guest bridge, with only its parent-window I/O replaced. */
async function startGuest(html: string) {
    const listeners: ((event: { data: unknown; source: unknown; ports: MessagePort[] }) => Promise<void>)[] = [];
    const calls: WireMessage[] = [];
    const log = vi.fn();
    let settle!: (message: WireMessage) => void;
    const settled = new Promise<WireMessage>((resolve) => (settle = resolve));
    const guestWindow: Record<string, any> = {
        parent: {
            postMessage(payload: WireMessage) {
                // postMessage clones synchronously; its traversal must be excluded from reads too.
                const message = structuredClone(payload);
                calls.push(message);
                if (message.type === "SCRIPT_SETTLED") {
                    settle(message);
                    return;
                }
                let result: unknown;
                let error: string | undefined;
                switch (message.method) {
                    case "_getPropertiesForInitialization":
                        result = { list: ["apiVersion"], apiVersion: "3.0" };
                        break;
                    case "_getAliases":
                        result = {
                            pluginStorage: { setItem: "_setPluginStorage", getItem: "_getPluginStorage" },
                        };
                        break;
                    case "getDatabase":
                        result = databaseFixture();
                        break;
                    case "_getPluginStorage":
                        result = "stored-value";
                        break;
                    case "nativeFetch":
                        error = "request refused";
                        break;
                    case "setDatabase":
                    case "_setPluginStorage":
                        result = undefined;
                        break;
                    default:
                        throw new Error(`Unexpected guest call: ${message.method}`);
                }
                const data = structuredClone({ type: "RESPONSE", reqId: message.reqId, result, error });
                queueMicrotask(() => {
                    for (const listener of listeners) void listener({ data, source: guestWindow.parent, ports: [] });
                });
            },
        },
        addEventListener(type: string, listener: (typeof listeners)[number]) {
            if (type === "message") listeners.push(listener);
        },
        postMessage() {},
    };
    const main = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)][0]?.[1];
    if (!main) throw new Error("Sandbox srcdoc has no guest script");
    // Bare `risuai` in alias initialization resolves to the guest window in a browser.
    const globalApi = new Proxy({}, { get: (_target, key) => guestWindow.risuai[key] });
    new Function("window", "document", "console", "risuai", main)(
        guestWindow,
        { querySelector: () => null },
        { log, error: vi.fn() },
        globalApi,
    );
    expect((await settled).failed).not.toBe(true);
    return {
        api: guestWindow.risuai as GuestApi,
        window: guestWindow,
        calls,
        logs: () => log.mock.calls.filter(([line]) => line.startsWith("[RisuAI Plugin:")).map(([line]) => line),
        consoleCalls: () => log.mock.calls,
    };
}

function recordedGuest(userCode = "") {
    return startGuest(sandboxHtml(userCode, { guestPrelude: databaseAccessRecorderScript(pluginName) }));
}

function report(line: string) {
    const prefix = line.match(/^\[RisuAI Plugin: (.+)\] getDatabase #(\d+)( update)?:/);
    expect(prefix).not.toBeNull();
    // Compare the reported data without depending on the order in which keys are printed.
    return {
        plugin: prefix![1],
        call: Number(prefix![2]),
        update: !!prefix![3],
        includeOnly: JSON.parse(line.match(/includeOnly=(\[[^\]]*\]|"all")/)![1]),
        keys: JSON.parse(line.match(/keys=(\[[^\]]*\])/)![1]).sort(),
        chats: line.match(/characters\[i\]\.chats touched=(true|false)/)![1] === "true",
        characters: Number(line.match(/characters=(\d+)/)![1]),
    };
}

describe("guest database access diagnostics", () => {
    it("reports each call's includeOnly, read keys and distinct chat touches once after two quiet seconds", async () => {
        const guest = await recordedGuest();
        const all = await guest.api.getDatabase();
        const subset = await guest.api.getDatabase(["temperature", "username"]);
        void all.username;
        void subset.temperature;
        await vi.advanceTimersByTimeAsync(1000);
        void all.characters[0].chats;
        await vi.advanceTimersByTimeAsync(500);
        void all.characters[1].chats;
        // Merely seeing a character does not count as reading its chats.
        void all.characters[2].name;
        await vi.advanceTimersByTimeAsync(499);
        expect(guest.logs()).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(guest.logs().map(report)).toEqual([
            {
                plugin: pluginName,
                call: 2,
                update: false,
                includeOnly: ["temperature", "username"],
                keys: ["temperature"],
                chats: false,
                characters: 0,
            },
        ]);
        await vi.advanceTimersByTimeAsync(1499);
        void all.username;
        void all.characters[0].chats;
        expect(guest.logs()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(guest.logs().map(report)).toEqual([
            expect.objectContaining({ call: 2 }),
            {
                plugin: pluginName,
                call: 1,
                update: false,
                includeOnly: "all",
                keys: ["characters", "username"],
                chats: true,
                characters: 2,
            },
        ]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(guest.logs()).toHaveLength(2);
        expect(guest.consoleCalls().filter(([line]) => line.startsWith("[RisuAI Plugin:"))).toEqual(
            guest.logs().map((line) => [line]),
        );
        expect(guest.logs().join("\n")).not.toMatch(/private-|791\.125/);
    });

    it("adds an update for newly read data after the first report without repeating known accesses", async () => {
        const guest = await recordedGuest();
        const database = await guest.api.getDatabase(["username", "characters"]);
        void database.username;
        await vi.advanceTimersByTimeAsync(2000);
        expect(guest.logs().map(report)).toEqual([
            {
                plugin: pluginName,
                call: 1,
                update: false,
                includeOnly: ["username", "characters"],
                keys: ["username"],
                chats: false,
                characters: 0,
            },
        ]);
        void database.username;
        await vi.advanceTimersByTimeAsync(2000);
        expect(guest.logs()).toHaveLength(1);
        void database.characters[0].chats;
        await vi.advanceTimersByTimeAsync(1999);
        expect(guest.logs()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(guest.logs().map(report)).toEqual([
            expect.objectContaining({ call: 1, update: false }),
            {
                plugin: pluginName,
                call: 1,
                update: true,
                includeOnly: ["username", "characters"],
                keys: ["characters", "username"],
                chats: true,
                characters: 1,
            },
        ]);
        void database.characters[0].chats;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(guest.logs()).toHaveLength(2);
    });

    it("keeps results cloneable and writable and excludes risuai serialization while preserving other API members", async () => {
        const guest = await recordedGuest();
        const database = await guest.api.getDatabase();
        database.temperature = 42;
        const expected = { ...databaseFixture(), temperature: 42 };
        await guest.api.setDatabase(database);
        await guest.api.pluginStorage.setItem("copy", { database });
        expect(guest.calls.filter((call) => call.method === "setDatabase")[0].args).toEqual([expected]);
        expect(guest.calls.filter((call) => call.method === "_setPluginStorage")[0].args).toEqual([
            "copy",
            { database: expected },
        ]);
        expect(guest.api.apiVersion).toBe("3.0");
        expect(guest.window.Risuai).toBe(guest.api);
        await expect(guest.api.pluginStorage.getItem("copy")).resolves.toBe("stored-value");
        await expect(guest.api.nativeFetch("https://example.test/refused")).rejects.toThrow("request refused");
        await vi.advanceTimersByTimeAsync(2000);
        expect(guest.logs().map(report)).toEqual([
            {
                plugin: pluginName,
                call: 1,
                update: false,
                includeOnly: "all",
                keys: [],
                chats: false,
                characters: 0,
            },
        ]);
        // Use the native structured clone, not the setup's JSON-based safeStructuredClone shim.
        expect(Object.getPrototypeOf(database)).toBe(Object.prototype);
        expect(structuredClone(database)).toEqual(expected);
        expect(JSON.stringify(database)).toBe(JSON.stringify(expected));
        expect({ ...database }).toEqual(expected);
    });

    it("omits the recorder without a prelude and installs it before the plugin's first database read when supplied", async () => {
        const userCode = "window.firstRead = (await window.risuai.getDatabase()).username;";
        const plainHtml = sandboxHtml(userCode);
        expect(plainHtml).not.toContain("[RisuAI Plugin:");
        const plain = await startGuest(plainHtml);
        const recorded = await recordedGuest(userCode);
        expect(plain.window.firstRead).toBe("private-username");
        expect(recorded.window.firstRead).toBe("private-username");
        await vi.advanceTimersByTimeAsync(2000);
        expect(plain.logs()).toEqual([]);
        expect(recorded.logs().map(report)).toEqual([
            {
                plugin: pluginName,
                call: 1,
                update: false,
                includeOnly: "all",
                keys: ["username"],
                chats: false,
                characters: 0,
            },
        ]);
    });

    it("selects the recorder only when Enable Dev Tools is true at plugin load", async () => {
        installFlatDatabase({ characters: [], plugins: [], enableDevTools: false });
        vi.spyOn(console, "log").mockImplementation(() => {});
        const plugin: RisuPlugin = {
            name: pluginName,
            version: "3.0",
            script: "",
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
        };
        await executePluginV3(plugin);
        const disabledHtml = srcdocs.at(-1)!;
        const recorder = databaseAccessRecorderScript(pluginName);
        expect(disabledHtml).not.toContain(recorder);
        expect(disabledHtml).not.toContain("[RisuAI Plugin:");
        await loadV3Plugins([]);
        settings.ui.enableDevTools = true;
        await executePluginV3(plugin);
        expect(srcdocs.at(-1)).toContain(recorder);
        settings.ui.enableDevTools = false;
        await loadV3Plugins([]);
        await executePluginV3(plugin);
        expect(srcdocs.at(-1)).not.toContain(recorder);
    });
});
