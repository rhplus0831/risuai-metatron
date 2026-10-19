// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServerContext } from "../app.ts";
import { isLoopbackHost, readListenConfig } from "../listenConfig.ts";
import { TEST_INDEX_HTML } from "./testSupport.ts";

const ROOT = "/srv/risu";

describe("readListenConfig", () => {
    it("defaults to port 6001, every interface, rootDir/save, and no bypass", () => {
        expect(readListenConfig({}, ROOT)).toEqual({
            port: 6001,
            hostname: undefined,
            savePath: path.join(ROOT, "save"),
            authBypass: false,
        });
    });

    it("reads PORT and RISU_HOST, and resolves RISU_SAVE_DIR against the root", () => {
        expect(readListenConfig({ PORT: "6419", RISU_HOST: " 127.0.0.1 ", RISU_SAVE_DIR: "save-agent" }, ROOT)).toEqual(
            { port: 6419, hostname: "127.0.0.1", savePath: path.join(ROOT, "save-agent"), authBypass: false },
        );
        expect(readListenConfig({ RISU_SAVE_DIR: "/data/elsewhere" }, ROOT).savePath).toBe("/data/elsewhere");
        expect(readListenConfig({ RISU_HOST: "  ", RISU_SAVE_DIR: "  " }, ROOT)).toMatchObject({
            hostname: undefined,
            savePath: path.join(ROOT, "save"),
        });
    });

    it.each(["TRUE", "true", "1", " True "])("turns the bypass on with %j on a loopback host", (flag) => {
        expect(readListenConfig({ RISU_HOST: "127.0.0.1", RISU_AGENT_DEV_AUTH_BYPASS: flag }, ROOT).authBypass).toBe(
            true,
        );
    });

    it.each(["", "FALSE", "false", "0"])("leaves the bypass off with %j, on any host", (flag) => {
        expect(readListenConfig({ RISU_AGENT_DEV_AUTH_BYPASS: flag }, ROOT).authBypass).toBe(false);
        expect(readListenConfig({ RISU_HOST: "0.0.0.0", RISU_AGENT_DEV_AUTH_BYPASS: flag }, ROOT).authBypass).toBe(
            false,
        );
    });

    it("refuses an unknown bypass value", () => {
        expect(() => readListenConfig({ RISU_HOST: "127.0.0.1", RISU_AGENT_DEV_AUTH_BYPASS: "yes" }, ROOT)).toThrow(
            "Invalid RISU_AGENT_DEV_AUTH_BYPASS: yes",
        );
    });

    it.each([undefined, "0.0.0.0", "::", "192.168.1.10", "100.100.1.1", "localhost", "[::1]", "::ffff:127.0.0.1"])(
        "refuses the bypass when RISU_HOST is %j",
        (host) => {
            expect(() =>
                readListenConfig(
                    { ...(host === undefined ? {} : { RISU_HOST: host }), RISU_AGENT_DEV_AUTH_BYPASS: "TRUE" },
                    ROOT,
                ),
            ).toThrow(/RISU_AGENT_DEV_AUTH_BYPASS needs RISU_HOST set to a numeric loopback address/);
        },
    );
});

describe("isLoopbackHost", () => {
    it.each(["127.0.0.1", "127.42.3.4", "127.255.255.255", "::1", "0:0:0:0:0:0:0:1"])("accepts %j", (host) => {
        expect(isLoopbackHost(host)).toBe(true);
    });

    it.each(["localhost", "LOCALHOST", "[::1]", "[127.0.0.1]", "0.0.0.0", "::", "128.0.0.1", "::ffff:127.0.0.1", ""])(
        "refuses %j",
        (host) => {
            expect(isLoopbackHost(host)).toBe(false);
        },
    );
});

describe("createServerContext savePath and authBypass", () => {
    const roots: string[] = [];
    const contexts: ReturnType<typeof createServerContext>[] = [];

    beforeAll(() => {
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterAll(() => {
        vi.restoreAllMocks();
    });
    afterEach(async () => {
        await Promise.all(contexts.splice(0).map((context) => context.dispose()));
        for (const root of roots.splice(0)) {
            rmSync(root, { recursive: true, force: true });
        }
    });

    function makeContext(options: { authBypass?: boolean; savePath?: (root: string) => string; password?: string }) {
        const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-listen-test-"));
        roots.push(rootDir);
        mkdirSync(path.join(rootDir, "dist"));
        writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
        const savePath = options.savePath?.(rootDir);
        if (options.password !== undefined) {
            const serverDir = path.join(savePath ?? path.join(rootDir, "save"), "server");
            mkdirSync(serverDir, { recursive: true });
            writeFileSync(path.join(serverDir, "password"), options.password);
        }
        const context = createServerContext({ rootDir, savePath, authBypass: options.authBypass });
        contexts.push(context);
        return { rootDir, context };
    }

    const readBody = JSON.stringify({ resources: [] });

    it("keeps the store in savePath and leaves rootDir/save alone", async () => {
        const { rootDir } = makeContext({ savePath: (root) => path.join(root, "save-agent") });
        expect(existsSync(path.join(rootDir, "save-agent", "data", "resources.sqlite"))).toBe(true);
        expect(existsSync(path.join(rootDir, "save-agent", "server"))).toBe(true);
        expect(existsSync(path.join(rootDir, "save"))).toBe(false);
    });

    it("answers test_auth with success and lets protected routes through without a token", async () => {
        const { context } = makeContext({ authBypass: true });
        const status = await context.app.request("/api/test_auth");
        expect(await status.json()).toEqual({ status: "success" });

        const read = await context.app.request("/api/resources/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: readBody,
        });
        expect(await read.json()).not.toEqual({ error: "No auth header" });
    });

    it("answers success even when a password is set and the token is unknown", async () => {
        const { context } = makeContext({ authBypass: true, password: "digest" });
        const status = await context.app.request("/api/test_auth", { headers: { "risu-auth": "not.a.jwt" } });
        expect(await status.json()).toEqual({ status: "success" });
    });

    it("keeps the normal checks without the bypass", async () => {
        const { context } = makeContext({});
        const status = await context.app.request("/api/test_auth");
        expect(await status.json()).toEqual({ status: "unset" });

        const read = await context.app.request("/api/resources/read", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: readBody,
        });
        expect(read.status).toBe(400);
        expect(await read.json()).toEqual({ error: "No auth header" });
    });
});
