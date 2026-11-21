// @vitest-environment node
import { createHash, createPublicKey } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, onTestFinished, vi } from "vitest";
import * as hostConfig from "./headlessHostConfig.mjs";

// Run the CLI entry point with a fake clock and mocked I/O.
const source = readFileSync(new URL("./headlessHost.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("const windows = ")).replace('await import("playwright-core")', "driver");
const listenerKey = createPublicKey({
    key: Buffer.from("MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=", "base64"),
    format: "der",
    type: "spki",
});

function connectedSocket(event: string) {
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    queueMicrotask(() => socket.emit(event));
    return socket;
}

function createPage(pluginsOff: boolean) {
    let lockScreenVisible = true;
    const screen = {
        getAttribute: () => "false",
        evaluate: () => ({ feed: "true", pluginsOff, commands: [] }),
        dispose() {},
    };
    return Object.assign(new EventEmitter(), {
        isClosed: () => false,
        $: (selector: string) => (lockScreenVisible && selector === "[data-remote-host-screen]" ? screen : null),
        hideLockScreen() {
            lockScreenVisible = false;
        },
        async close() {},
        async goto() {},
    });
}

function runHost({ pluginsOff = false, tlsAuthorized }: { pluginsOff?: boolean; tlsAuthorized?: boolean } = {}) {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const lines: string[] = [];
    const processStub = Object.assign(new EventEmitter(), {
        platform: "linux",
        env: { RISU_CHROME: "/test/browser" },
        stdout: { write: (_: string, done: () => void) => done() },
        exit: vi.fn(),
    });
    onTestFinished(() => {
        processStub.emit("SIGTERM");
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    let page: ReturnType<typeof createPage> | undefined;
    const context = Object.assign(new EventEmitter(), {
        async close() {},
        browser: () => undefined,
        setDefaultTimeout() {},
        addInitScript() {},
        pages: () => (page ? [page] : []),
        newCDPSession: async () => Object.assign(new EventEmitter(), { send() {} }),
        newPage: async () => (page = createPage(pluginsOff)),
    });
    const launchPersistentContext = vi
        .fn<(profileDir: string, options: { ignoreHTTPSErrors: boolean; args?: string[] }) => Promise<typeof context>>()
        .mockResolvedValue(context);
    runInNewContext(body, {
        ...hostConfig,
        createHash,
        rootDir: "/test",
        driver: { chromium: { launchPersistentContext } },
        process: processStub,
        URL,
        Date,
        setTimeout,
        clearTimeout,
        console: { log: (line: string) => lines.push(line) },
        mkdir: async () => {},
        existsSync: () => true,
        net: { connect: () => connectedSocket("connect") },
        tls: {
            connect: () =>
                Object.assign(connectedSocket(tlsAuthorized === undefined ? "end" : "secureConnect"), {
                    authorized: tlsAuthorized,
                    getPeerX509Certificate: () => ({ publicKey: listenerKey }),
                }),
        },
    });
    return {
        lines,
        launchPersistentContext,
        currentPage() {
            if (!page) throw new Error("Headless host has not opened a page");
            return page;
        },
    };
}

it.each([
    { listener: "HTTP", scheme: "http", tlsAuthorized: undefined, expectedArgs: [] },
    { listener: "verified HTTPS", scheme: "https", tlsAuthorized: true, expectedArgs: [] },
    {
        listener: "unverified HTTPS",
        scheme: "https",
        tlsAuthorized: false,
        expectedArgs: ["--ignore-certificate-errors-spki-list=BuP9j9opu2CrWVV95h7bCuzbIxE0vjDnW0Vfjht5L6k="],
    },
])("scopes certificate exceptions for $listener", async ({ scheme, tlsAuthorized, expectedArgs }) => {
    const host = runHost({ tlsAuthorized });
    await vi.advanceTimersByTimeAsync(0);

    expect(host.lines).toContainEqual(expect.stringContaining(` at ${scheme}://127.0.0.1:6001/`));
    const [, options] = host.launchPersistentContext.mock.calls[0];
    const certificateArgs = (options.args ?? []).filter(
        (arg) => arg.startsWith("--ignore-certificate-errors") || arg.startsWith("--allow-insecure-localhost"),
    );
    expect({ ignoreHTTPSErrors: options.ignoreHTTPSErrors, certificateArgs }).toEqual({
        ignoreHTTPSErrors: false,
        certificateArgs: expectedArgs,
    });
});

it("keeps page error frame positions while redacting script URLs", async () => {
    const host = runHost();
    await vi.advanceTimersByTimeAsync(0);

    const app = "http://127.0.0.1:6001";
    host.currentPage().emit("pageerror", {
        message: "render failed",
        stack: [
            "Error: render failed",
            `    at render (${app}/src/chat.js?session=fixture#entry:12:34)`,
            "    at eval (eval at setup (https://user:pass@cdn.example.test/private.js?v=2:5:6), <anonymous>:7:8)",
            `    at ${app}/src/app.js:90:1`,
        ].join("\n"),
    });

    expect(host.lines.at(-1)?.replace(/^\S+ /, "")).toBe(
        `Page error: Error: render failed at render (${app}/src/chat.js[redacted]:12:34) ` +
            "at eval (eval at setup (https://cdn.example.test/[redacted]:5:6), <anonymous>:7:8) " +
            `at ${app}/src/app.js:90:1`,
    );
});

it("logs the page error message when no stack is available", async () => {
    const host = runHost();
    await vi.advanceTimersByTimeAsync(0);

    host.currentPage().emit("pageerror", { message: "render failed" });

    expect(host.lines.at(-1)).toMatch(/ Page error: render failed$/);
});

it("backs off through repeated crashes and resets after a full minute ready", async () => {
    const host = runHost();
    await vi.advanceTimersByTimeAsync(1_000);

    const waits = [];
    for (let cycle = 0; cycle < 8; cycle++) {
        expect(host.lines.at(-1)).toContain("Feed up");
        host.currentPage().emit("crash");
        const wait = Number(host.lines.at(-1)?.match(/Restart in (\d+) s: page crashed$/)?.[1]);
        expect(wait).toBeGreaterThan(0);
        waits.push(wait);
        await vi.advanceTimersByTimeAsync(wait * 1_000 + 1_000);
    }
    expect(waits).toEqual([5, 10, 20, 40, 80, 160, 300, 300]);

    await vi.advanceTimersByTimeAsync(59_000);
    host.currentPage().emit("crash");
    expect(host.lines.at(-1)).toContain("Restart in 5 s: page crashed");
});

it("keeps the crash backoff when the lock screen disappears before a ready minute", async () => {
    const host = runHost();
    await vi.advanceTimersByTimeAsync(0);
    host.currentPage().emit("crash");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(host.lines.at(-1)).toContain("Feed up");

    const replacement = host.currentPage();
    await vi.advanceTimersByTimeAsync(50_000);
    replacement.hideLockScreen();
    await vi.advanceTimersByTimeAsync(12_000);
    replacement.emit("crash");

    expect(host.lines.at(-1)).toContain("Restart in 10 s: page crashed");
});

it("lets a live plugins-off page settle before reloading it", async () => {
    const host = runHost({ pluginsOff: true });
    await vi.advanceTimersByTimeAsync(0);
    const originalPage = host.currentPage();

    await vi.advanceTimersByTimeAsync(10_999);
    expect(host.currentPage()).toBe(originalPage);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.currentPage()).not.toBe(originalPage);
});
