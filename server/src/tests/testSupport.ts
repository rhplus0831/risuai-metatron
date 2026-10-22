// Shared helpers for the server tests (not a test file itself).
import { webcrypto } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { createServerContext, type RouteLimits } from "../app.ts";
import type { ResourceKind } from "../data/kinds.ts";
import type { UpstreamImportRunner } from "../data/upstream/importRunner.ts";
import type { MemoryTaskService } from "../../../shared/jobs.ts";
import type { ServerCbsTimeLimits } from "../jobs/cbsHost.ts";
import type { GenerationRunner } from "../jobs/generationJobs.ts";
import type { PushTransport } from "../push/pushService.ts";
import type { RealmStagingTimer } from "../routes/importRealm.ts";
import type { HypaV3SeparatorLimits } from "../prompt/memory/host.ts";
import type { MemoryTaskLimits } from "../prompt/memory/memoryTasks.ts";
import type { ScriptWorkerTimingOptions } from "../scripts/workerPool.ts";
import { allowTestLoopbackOrigin } from "../../../vitest.testNetwork.ts";

export { allowTestLoopbackOrigin };

export const TEST_INDEX_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';

/**
 * A server context over a temporary `rootDir` with a minimal `dist/index.html`. `resourceKinds`
 * replaces the default resource kinds (for a rejecting or transforming normalizer).
 */
export type TestServerOptions = {
    password?: string;
    resourceKinds?: readonly ResourceKind[];
    snapshotIntervalMs?: number;
    /**
     * The script workers' graces, boot cap, synchronous-call wait, and default allowances, deadline and
     * budget (the defaults are the production ones; `unhurriedLimits.ts` lengthens all but the graces).
     */
    scriptWorkerOptions?: ScriptWorkerTimingOptions;
    maxImportBytes?: number;
    /** The generation jobs' runner (the default runs command jobs and sends). */
    generationRunner?: GenerationRunner;
    /** The default runner's random source (`presetChain`, the group order). */
    generationRandom?: () => number;
    /** The Web Push transport; the default is the real `web-push`. */
    pushTransport?: PushTransport;
    /** Reuse an existing root (a restart); `password` is ignored then. */
    rootDir?: string;
    /** The Realm download's origin, the `/hub-proxy` target (local upstreams in tests), and the staged import's expiry. */
    realm?: { downloadOrigin?: string; hubURL?: string; stagedTtlMs?: number };
    /** The upstream RisuAI import's staged expiry and what runs a prepare (an in-process stage in tests). */
    upstreamImport?: { stagedTtlMs?: number; runner?: UpstreamImportRunner };
    /** The upstream RisuAI-compatible export's staged expiry. */
    upstreamExport?: { stagedTtlMs?: number };
    /** What schedules a staged Realm import's expiry (a test holds the callback and fires it). */
    realmStagingTimer?: RealmStagingTimer;
    /** The default runner's trigger effect-loop clock (a test freezes or steps the 50 ms yield window). */
    generationEffectClock?: () => number;
    /** An aborted generation job's grace before it is ended for it (default 5 s). */
    generationAbortGraceMs?: number;
    /** The default runner's HypaV3 separator limits (default 5 s chunking, 1 s per split). */
    generationHypaV3SeparatorLimits?: HypaV3SeparatorLimits;
    /** Lower rate limits and asset batch, backup archive, and CharX entry caps (default the production ones). */
    routeLimits?: RouteLimits;
    /** The CBS wall times of the jobs, renders, and translations (default 5 s per template, 60 s per job). */
    cbsTimeLimits?: ServerCbsTimeLimits;
    /** The default runner's memory task service (a fake one); `"disabled"` or unset: none. */
    memoryTasks?: "disabled" | MemoryTaskService;
    /**
     * The context's own memory task service: `manualAdmission` opens its start and cancel routes
     * (closed by default, as in production), `now` and `limits` replace its clock and caps.
     */
    memoryTaskOptions?: { manualAdmission?: boolean; now?: () => number; limits?: Partial<MemoryTaskLimits> };
};

export function createTestServer(options: TestServerOptions = {}) {
    const rootDir = options.rootDir ?? mkdtempSync(path.join(os.tmpdir(), "risu-server-test-"));
    const savePath = path.join(rootDir, "save");
    if (!options.rootDir) {
        mkdirSync(path.join(rootDir, "dist"));
        writeFileSync(path.join(rootDir, "dist", "index.html"), TEST_INDEX_HTML);
        mkdirSync(savePath);
        if (options.password !== undefined) {
            // The server's own files live under `save/server/`, outside the storage namespaces.
            mkdirSync(path.join(savePath, "server"));
            writeFileSync(path.join(savePath, "server", "password"), options.password);
        }
    }
    const context = createServerContext({
        rootDir,
        resourceKinds: options.resourceKinds,
        snapshotIntervalMs: options.snapshotIntervalMs,
        scriptWorkerOptions: options.scriptWorkerOptions,
        maxImportBytes: options.maxImportBytes,
        generationRunner: options.generationRunner,
        generationRandom: options.generationRandom,
        pushTransport: options.pushTransport,
        realm: options.realm,
        upstreamImport: options.upstreamImport,
        upstreamExport: options.upstreamExport,
        realmStagingTimer: options.realmStagingTimer,
        generationEffectClock: options.generationEffectClock,
        generationAbortGraceMs: options.generationAbortGraceMs,
        generationHypaV3SeparatorLimits: options.generationHypaV3SeparatorLimits,
        routeLimits: options.routeLimits,
        cbsTimeLimits: options.cbsTimeLimits,
        memoryTasks: options.memoryTasks,
        memoryTaskOptions: options.memoryTaskOptions,
    });
    return {
        rootDir,
        savePath,
        context,
        app: context.app,
        async close() {
            await context.dispose();
            rmSync(rootDir, { recursive: true, force: true });
        },
    };
}

export type ResourceTestClient = Awaited<ReturnType<typeof createResourceTestClient>>;

/**
 * A test server with a registered client: every request carries a fresh JWT, and every request
 * carries the database epoch the client last read (`x-resource-epoch`), unless `epoch` overrides it
 * (`null` omits the header). `readEpoch` refreshes it after a restore.
 */
export async function createResourceTestClient(
    options: Omit<TestServerOptions, "password"> & { epochKind?: string } = {},
) {
    // Any registered kind's list answers the epoch; `ui` is a section every default store holds.
    const { epochKind = "ui", ...serverOptions } = options;
    const s = createTestServer({ password: "pw", ...serverOptions });
    const signer = await createSigner();
    await s.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
    const client = {
        ...s,
        signer,
        epoch: "",
        async headers(extra: Record<string, string> = {}, epoch: string | null | undefined = undefined) {
            const headers: Record<string, string> = { "risu-auth": await signer.jwt() };
            const value = epoch === undefined ? client.epoch : epoch;
            if (value !== null) {
                headers["x-resource-epoch"] = value;
            }
            return { ...headers, ...extra };
        },
        async request(url: string, init: RequestInit = {}, epoch?: string | null) {
            return s.app.request(url, {
                ...init,
                headers: await client.headers((init.headers as Record<string, string> | undefined) ?? {}, epoch),
            });
        },
        async json(url: string, body: unknown, init: RequestInit = {}, epoch?: string | null) {
            return client.request(
                url,
                {
                    method: "POST",
                    ...init,
                    headers: { "content-type": "application/json", ...init.headers },
                    body: JSON.stringify(body),
                },
                epoch,
            );
        },
        async readEpoch() {
            const res = await client.request(`/api/resources/${epochKind}`);
            client.epoch = ((await res.json()) as { epoch: string }).epoch;
            return client.epoch;
        },
        put: (kind: string, id: string, body: unknown, epoch?: string | null) =>
            client.json(`/api/resources/${kind}/${encodeURIComponent(id)}`, body, { method: "PUT" }, epoch),
        get: (kind: string, id: string) => client.request(`/api/resources/${kind}/${encodeURIComponent(id)}`),
        list: (kind: string) => client.request(`/api/resources/${kind}`),
        remove: (kind: string, id: string, query: string, epoch?: string | null) =>
            client.request(`/api/resources/${kind}/${encodeURIComponent(id)}${query}`, { method: "DELETE" }, epoch),
        batch: (ops: unknown, epoch?: string | null) => client.json("/api/resources/batch", { ops }, {}, epoch),
        readKinds: (kinds: string) => client.request(`/api/resources?kinds=${kinds}`),
        readRefs: (refs: unknown) => client.json("/api/resources/read", { refs }),
        /** Creates a record and returns its revision token. */
        async create(kind: string, id: string, data: unknown): Promise<string> {
            const res = await client.put(kind, id, { baseRevision: null, data });
            if (res.status !== 200) {
                throw new Error(`create ${kind}/${id}: ${res.status} ${await res.text()}`);
            }
            return ((await res.json()) as { revision: string }).revision;
        },
    };
    await client.readEpoch();
    return client;
}

/** Builds a local backup archive (`u32le nameLength, name, u32le dataLength, bytes` records). */
export function buildArchive(records: [string, Uint8Array | string][]): Uint8Array {
    const parts: Buffer[] = [];
    for (const [name, data] of records) {
        const nameBytes = Buffer.from(name, "utf-8");
        const bytes = typeof data === "string" ? Buffer.from(data, "utf-8") : Buffer.from(data);
        const header = Buffer.alloc(8 + nameBytes.length);
        header.writeUInt32LE(nameBytes.length, 0);
        nameBytes.copy(header, 4);
        header.writeUInt32LE(bytes.length, 4 + nameBytes.length);
        parts.push(header, bytes);
    }
    return Buffer.concat(parts);
}

/** Splits an archive into its records. */
export function parseArchive(bytes: Uint8Array): { name: string; data: Buffer }[] {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const records: { name: string; data: Buffer }[] = [];
    let offset = 0;
    while (offset < buffer.length) {
        const nameLength = buffer.readUInt32LE(offset);
        const name = buffer.subarray(offset + 4, offset + 4 + nameLength).toString("utf-8");
        const dataLength = buffer.readUInt32LE(offset + 4 + nameLength);
        const start = offset + 8 + nameLength;
        records.push({ name, data: buffer.subarray(start, start + dataLength) });
        offset = start + dataLength;
    }
    return records;
}

export const hex = (s: string) => Buffer.from(s, "utf-8").toString("hex");
export const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
});

/** An ES256 key pair with a JWT signer matching the client's `serverAuth.ts` token signer. */
export async function createSigner() {
    const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
    ]);
    const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return {
        publicJwk,
        async jwt(opts: { exp?: number; alg?: string; breakSignature?: boolean } = {}) {
            const now = Math.floor(Date.now() / 1000);
            const header = b64({ alg: opts.alg ?? "ES256", typ: "JWT" });
            const payload = b64({ iat: now, exp: opts.exp ?? now + 300, pub: publicJwk });
            const signature = Buffer.from(
                await webcrypto.subtle.sign(
                    { name: "ECDSA", hash: "SHA-256" },
                    keyPair.privateKey,
                    Buffer.from(`${header}.${payload}`),
                ),
            );
            if (opts.breakSignature) {
                signature[0] ^= 0xff;
            }
            return `${header}.${payload}.${signature.toString("base64url")}`;
        },
    };
}

export type UpstreamRequest = {
    method: string;
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
    /** True once the upstream response (and its socket) closed. */
    closed: boolean;
};

/**
 * A local HTTP upstream that records every request. Paths: `/echo` returns the request as JSON with
 * `cache-control` and CSP headers; `/sse` streams three events; `/stall` sends headers and one
 * chunk, then never ends; `/hang` never responds; `/redirect` sends a relative 302 to `/final`;
 * `/redirect-off` sends a 302 to another origin (`https://docs.example/lua`).
 */
export async function startUpstream() {
    const requests: UpstreamRequest[] = [];
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        req.on("error", () => {});
        for await (const chunk of req) {
            chunks.push(chunk as Buffer);
        }
        const record: UpstreamRequest = {
            method: req.method ?? "",
            url: req.url ?? "",
            headers: req.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
            closed: false,
        };
        requests.push(record);
        res.on("close", () => {
            record.closed = true;
        });
        const url = req.url ?? "";
        if (url.startsWith("/sse")) {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "content-security-policy": "default-src 'none'",
            });
            let i = 0;
            const timer = setInterval(() => {
                res.write(`data: ${i}\n\n`);
                if (++i === 3) {
                    clearInterval(timer);
                    res.end();
                }
            }, 20);
            return;
        }
        if (url.startsWith("/stall")) {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.flushHeaders();
            res.write("data: first\n\n");
            return;
        }
        if (url.startsWith("/hang")) {
            return;
        }
        if (url.startsWith("/redirect-off")) {
            res.writeHead(302, { location: "https://docs.example/lua", "x-first": "yes" });
            res.end("moved");
            return;
        }
        if (url.startsWith("/redirect")) {
            res.writeHead(302, { location: "/final?from=redirect", "x-first": "yes" });
            res.end("moved");
            return;
        }
        if (url.startsWith("/final")) {
            res.writeHead(200, { "content-type": "text/plain", "x-final": "yes" });
            res.end("final body");
            return;
        }
        res.writeHead(200, {
            "content-type": "application/json",
            "cache-control": "max-age=100",
            "content-security-policy": "default-src 'none'",
            "x-upstream": "echo",
        });
        res.end(JSON.stringify({ method: record.method, url: record.url, headers: record.headers, body: record.body }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        url: allowListenerOrigin(server),
        requests,
        /** Waits until the upstream has received `count` requests. */
        async received(count: number) {
            await waitFor(() => requests.length >= count);
            return requests[count - 1];
        },
        close() {
            server.closeAllConnections();
            server.close();
        },
    };
}

/** A listening server: a `node:http`/`node:net` server, or a `ws` `WebSocketServer`. */
type LoopbackListener = {
    address(): AddressInfo | string | null;
    close(...args: never[]): unknown;
    once(event: "close", listener: () => void): unknown;
};

/**
 * Lets the test reach a server it started: registers the listening loopback server's `http:`
 * origin (which also admits `ws:`) with the unit-test network guard (`vitest.testNetwork.ts`,
 * installed by `vitest.setup.ts`) until `server.close()` is called or the server closes. Call it
 * after the server listens. Returns the origin.
 */
export function allowListenerOrigin(server: LoopbackListener): string {
    const { address, family, port } = server.address() as AddressInfo;
    const origin = `http://${family === "IPv6" ? `[${address}]` : address}:${port}`;
    const unregister = allowTestLoopbackOrigin(origin);
    const close = server.close;
    server.close = function (this: LoopbackListener, ...args: never[]) {
        unregister();
        return close.apply(this, args);
    };
    server.once("close", unregister);
    return origin;
}

/**
 * Polls `condition` (awaited when it returns a promise) every `stepMs` until it holds. Without
 * `timeoutMs` there is no polling deadline of its own: the test's Vitest timeout reports a condition
 * that never holds as a failure, and a stall that only delays it fails nothing. A cap is for
 * slow-tier tests only; it yields one event-loop turn (`setImmediate`) and re-checks before it throws.
 */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs?: number, stepMs = 10) {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    while (!(await condition())) {
        if (Date.now() > deadline) {
            await new Promise((resolve) => setImmediate(resolve));
            if (await condition()) {
                return;
            }
            throw new Error("waitFor: condition not met in time");
        }
        await new Promise((resolve) => setTimeout(resolve, stepMs));
    }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
