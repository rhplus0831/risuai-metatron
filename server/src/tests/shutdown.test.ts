// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RESOURCE_KINDS } from "../data/kinds.ts";
import {
    allowTestLoopbackOrigin,
    buildArchive,
    createResourceTestClient,
    createSigner,
    sleep,
    TEST_INDEX_HTML,
    waitFor,
} from "./testSupport.ts";

const MAIN = path.resolve(import.meta.dirname, "../main.ts");

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

let child: ChildProcess | undefined;
let rootDir: string | undefined;
let unregisterMain: (() => void) | undefined;
afterEach(async () => {
    unregisterMain?.();
    unregisterMain = undefined;
    if (child && child.exitCode === null) {
        child.kill("SIGKILL");
        await new Promise((resolve) => child?.once("exit", resolve));
    }
    child = undefined;
    if (rootDir) {
        rmSync(rootDir, { recursive: true, force: true });
        rootDir = undefined;
    }
});

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

/** Starts `main.ts` in a temporary root, registers a client, and returns request helpers. */
async function startMain() {
    rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-shutdown-"));
    mkdirSync(path.join(rootDir, "dist"));
    writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
    mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
    writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");
    const port = await freePort();
    child = spawn(process.execPath, [MAIN], {
        cwd: rootDir,
        env: { ...process.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child!.once("exit", (code) => resolve(code)));

    const base = `http://127.0.0.1:${port}`;
    unregisterMain = allowTestLoopbackOrigin(base);
    await waitFor(() => output.includes("server is running"), 10_000, 25);
    const signer = await createSigner();
    const login = await fetch(`${base}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "pw", publicKey: signer.publicJwk }),
    });
    expect(login.status).toBe(200);
    const headers = async () => ({ "risu-auth": await signer.jwt() });
    const epoch = (
        (await (await fetch(`${base}/api/resources/ui`, { headers: await headers() })).json()) as {
            epoch: string;
        }
    ).epoch;
    return { port, base, headers, epoch, exited, output: () => output, savePath: path.join(rootDir!, "save") };
}

describe("main.ts graceful shutdown", () => {
    it("lets an import admitted before SIGTERM finish and deliver its response, then exits 0", async () => {
        const server = await startMain();
        // A resource database with one character, built by a second in-process server.
        const source = await createResourceTestClient();
        await source.create("characters", "c1", { chaId: "c1" });
        const snapshot = await source.context.snapshots.snapshotNow();
        const database = readFileSync(path.join(source.savePath, "backups", `${snapshot.id}.sqlite`));
        await source.close();
        const manifest = JSON.stringify({ version: 2, createdAt: "", partial: false, assets: [], missing: [] });
        const archive = buildArchive([
            ["manifest.json", manifest],
            ["resources.sqlite", database],
        ]);

        const result: { status?: number; ended?: boolean; error?: string } = {};
        const request = http.request(
            {
                host: "127.0.0.1",
                port: server.port,
                path: "/api/backups/import",
                method: "POST",
                headers: { ...(await server.headers()), "x-resource-epoch": server.epoch },
            },
            (res) => {
                result.status = res.statusCode;
                res.on("data", () => {});
                res.on("end", () => (result.ended = true));
            },
        );
        request.on("error", (error) => (result.error = error.message));
        request.write(archive.subarray(0, 16));
        await waitFor(() => readdirSync(path.join(server.savePath, ".tmp")).some((n) => n.startsWith("import-")));

        child!.kill("SIGTERM");
        await sleep(150);
        request.end(archive.subarray(16));
        const code = await server.exited;
        request.destroy();

        expect(result).toEqual({ status: 200, ended: true });
        expect(code).toBe(0);
        expect(readdirSync(path.join(server.savePath, ".tmp"))).toEqual([]);
        const live = new DatabaseSync(path.join(server.savePath, "data", "resources.sqlite"), { readOnly: true });
        try {
            // The materialized singletons are in every store; the imported character is the only
            // other row.
            const materialized = new Set(DEFAULT_RESOURCE_KINDS.filter((k) => k.materialize).map((k) => k.name));
            const rows = live.prepare("SELECT kind, id FROM resources").all() as { kind: string; id: string }[];
            expect(rows.filter((r) => !materialized.has(r.kind))).toEqual([{ kind: "characters", id: "c1" }]);
        } finally {
            live.close();
        }
        expect(server.output()).toContain("SIGTERM received");
    }, 20_000);

    it("lets a resource write admitted before SIGTERM land with 200, then exits 0", async () => {
        const server = await startMain();
        const result: { status?: number; ended?: boolean; error?: string } = {};
        const continued = deferred<void>();
        const responseEnded = deferred<void>();
        const request = http.request(
            {
                host: "127.0.0.1",
                port: server.port,
                path: "/api/resources/characters/late",
                method: "PUT",
                headers: {
                    ...(await server.headers()),
                    "content-type": "application/json",
                    "x-resource-epoch": server.epoch,
                    Expect: "100-continue",
                },
            },
            (res) => {
                result.status = res.statusCode;
                res.on("data", () => {});
                res.on("end", () => {
                    result.ended = true;
                    responseEnded.resolve();
                });
                res.on("close", () => responseEnded.resolve());
            },
        );
        request.on("error", (error) => {
            result.error = error.message;
            responseEnded.resolve();
        });
        request.once("continue", () => continued.resolve());
        request.flushHeaders();
        // In this Node/Hono stack, automatic 100 Continue and synchronous request dispatch reach
        // admission before a SIGTERM handler can run. This is not a general HTTP guarantee.
        await continued.promise;
        request.write('{"baseRevision":null,"data":');

        child!.kill("SIGTERM");
        await waitFor(() => server.output().includes("SIGTERM received"), 5000);
        request.end('{"chaId":"late"}}');
        const [, code] = await Promise.all([responseEnded.promise, server.exited]);
        request.destroy();

        expect(result).toEqual({ status: 200, ended: true });
        expect(code).toBe(0);
        const live = new DatabaseSync(path.join(server.savePath, "data", "resources.sqlite"), { readOnly: true });
        try {
            expect(live.prepare("SELECT id FROM resources WHERE id = 'late'").all()).toEqual([{ id: "late" }]);
        } finally {
            live.close();
        }
    }, 20_000);

    it("exits promptly on SIGINT with an idle keep-alive connection open", async () => {
        const server = await startMain();
        const agent = new http.Agent({ keepAlive: true });
        const idle = await new Promise<http.IncomingMessage>((resolve, reject) => {
            http.get({ host: "127.0.0.1", port: server.port, path: "/", agent }, resolve).on("error", reject);
        });
        idle.resume();
        await new Promise((resolve) => idle.on("end", resolve));

        const started = Date.now();
        child!.kill("SIGINT");
        const code = await server.exited;
        agent.destroy();
        expect(code).toBe(0);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(server.output()).toContain("SIGINT received");
    }, 20_000);
});
