// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, onTestFinished, vi } from "vitest";
import * as hostConfig from "./headlessHostConfig.mjs";

// Run the CLI with its process, browser, and listener I/O replaced.
const source = readFileSync(new URL("./headlessHost.mjs", import.meta.url), "utf8");
const body = source.slice(source.indexOf("const windows = ")).replace('await import("playwright-core")', "driver");

function connectedSocket(event: string) {
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    queueMicrotask(() => socket.emit(event));
    return socket;
}

function createPage(pluginsOff: boolean) {
    const screen = {
        getAttribute: () => "false",
        evaluate: () => ({ feed: "true", pluginsOff, commands: [] }),
        dispose() {},
    };
    return Object.assign(new EventEmitter(), {
        isClosed: () => false,
        $: (selector: string) => (selector === "[data-remote-host-screen]" ? screen : null),
        async close() {},
        async goto() {},
    });
}

function runHost({ pluginsOff = false } = {}) {
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
    runInNewContext(body, {
        ...hostConfig,
        rootDir: "/test",
        driver: { chromium: { launchPersistentContext: async () => context } },
        process: processStub,
        URL,
        Date,
        setTimeout,
        clearTimeout,
        console: { log: (line: string) => lines.push(line) },
        mkdir: async () => {},
        existsSync: () => true,
        net: { connect: () => connectedSocket("connect") },
        tls: { connect: () => connectedSocket("end") },
    });
    return {
        lines,
        currentPage() {
            if (!page) throw new Error("Headless host has not opened a page");
            return page;
        },
    };
}

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

it("lets a live plugins-off page settle before reloading it", async () => {
    const host = runHost({ pluginsOff: true });
    await vi.advanceTimersByTimeAsync(0);
    const originalPage = host.currentPage();

    await vi.advanceTimersByTimeAsync(10_999);
    expect(host.currentPage()).toBe(originalPage);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.currentPage()).not.toBe(originalPage);
});
