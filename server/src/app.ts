import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "./data/kinds.ts";
import { createResourceStore, ResourceStoreClosedError } from "./data/resourceStore.ts";
import { createSnapshotManager, MaintenanceError } from "./data/snapshots.ts";
import { compileTrust, getClientIp, parseTrustProxyEnv } from "./http/clientIp.ts";
import { createRateLimiter } from "./http/rateLimit.ts";
import { createGenerationJobs, type GenerationRunner } from "./jobs/generationJobs.ts";
import { createGenerationLock } from "./jobs/generationLock.ts";
import { createAuthStore } from "./routes/auth.ts";
import { BACKUP_IMPORT_PATH, DEFAULT_MAX_IMPORT_BYTES, registerBackupRoutes } from "./routes/backups.ts";
import { registerGenerationRoutes } from "./routes/generations.ts";
import { registerProxyRoutes } from "./routes/proxy.ts";
import { createProxyStreamJobs } from "./routes/proxyStreamJobs.ts";
import { registerResourceRoutes } from "./routes/resources.ts";
import { registerStorageRoutes } from "./routes/storage.ts";
import { createScriptWorkerPool } from "./scripts/workerPool.ts";
import type { AppEnv } from "./types.ts";

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const headOpenTag = /<head(\s[^>]*)?>/i;

export type ServerContext = ReturnType<typeof createServerContext>;

/**
 * Builds the self-host server: `rootDir/dist` is the built client, `rootDir/save` the storage.
 * All state (password, known keys, stream jobs, rate-limit counters, the resource database and its
 * snapshots) lives in the returned context. `resourceKinds` replaces the default resource kinds and
 * `snapshotIntervalMs` the 10-minute snapshot interval (tests use them); `maxImportBytes` caps an
 * uploaded backup archive (default `RISU_MAX_IMPORT_BYTES`, else 16 GiB). `generationRunner` runs
 * the generation jobs (tests inject one; the default answers 501 until prompt assembly).
 */
export function createServerContext(options: {
    rootDir: string;
    trustProxy?: string;
    resourceKinds?: readonly ResourceKind[];
    snapshotIntervalMs?: number;
    maxImportBytes?: number;
    generationRunner?: GenerationRunner;
}) {
    const savePath = path.join(options.rootDir, "save");
    const distPath = path.join(options.rootDir, "dist");
    mkdirSync(savePath, { recursive: true });

    const trust = compileTrust(parseTrustProxyEnv(options.trustProxy));
    const clientIp = (c: Parameters<typeof getClientIp>[0]) => getClientIp(c, trust);

    const auth = createAuthStore(savePath);
    const resourceKinds = createKindRegistry(options.resourceKinds ?? DEFAULT_RESOURCE_KINDS);
    // The store consults the lock on every write that could rewrite or remove a job's message.
    const generationLock = createGenerationLock();
    // `save/data/` is not a storage namespace, so the `/api/*` storage routes cannot reach the file.
    const resources = createResourceStore({
        file: path.join(savePath, "data", "resources.sqlite"),
        kinds: resourceKinds,
        guard: generationLock,
    });
    const snapshots = createSnapshotManager({
        store: resources,
        dir: path.join(savePath, "backups"),
        intervalMs: options.snapshotIntervalMs,
    });
    const maxImportBytes = options.maxImportBytes ?? parseMaxImportBytes(process.env.RISU_MAX_IMPORT_BYTES);
    const proxyStreamJobs = createProxyStreamJobs({ auth });
    const generationJobs = createGenerationJobs({
        store: resources,
        kinds: resourceKinds,
        gate: snapshots.gate,
        snapshots,
        lock: generationLock,
        authorize: auth.isAuthorizedToken,
        runner: options.generationRunner,
    });
    /** The one `upgrade` listener per HTTP server (proxy stream jobs, then generation jobs). */
    const upgradeListeners = new Map<http.Server, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void>();
    // Workers start on the first task; nothing runs scripts on the server yet (Phase 5 slice 8a).
    const scriptWorkers = createScriptWorkerPool({ rootDir: options.rootDir });

    const authenticatedRouteLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2000,
        message: "Too many requests. Please retry shortly.",
        keyOf: clientIp,
    });
    const authRouteLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2000,
        message: "Too many requests. Please retry shortly.",
        keyOf: clientIp,
    });
    const loginRouteLimiter = createRateLimiter({
        windowMs: 30 * 1000,
        limit: 10,
        message: "Too many attempts. Please wait and try again later.",
        keyOf: clientIp,
    });

    const app = new Hono<AppEnv>({ strict: false });
    let shuttingDown = false;
    let disposing: Promise<void> | undefined;

    function beginShutdown() {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        // Time zero of every job's abort deadline; `dispose` waits for them to end.
        generationJobs.beginShutdown();
        for (const [server, listener] of upgradeListeners) {
            server.off("upgrade", listener);
        }
        upgradeListeners.clear();
        proxyStreamJobs.dispose();
        authenticatedRouteLimiter.dispose();
        authRouteLimiter.dispose();
        loginRouteLimiter.dispose();
        void snapshots.stop();
    }

    app.onError((error, c) => {
        if (error instanceof ResourceStoreClosedError || error instanceof MaintenanceError) {
            c.header("Retry-After", "5");
            return c.json({ error: error.message }, 503);
        }
        if (error instanceof HTTPException) {
            return error.getResponse();
        }
        console.error(error);
        return c.text("Internal Server Error", 500);
    });

    // Admit resource handlers before their first await (including body parsing and auth). Tracking
    // them also makes in-process dispose safe; maintenance only waits for storage-gate admissions.
    app.use(async (c, next) => {
        const resource = /^\/api\/resources(?:\/|$)/.test(c.req.path);
        const backup = /^\/api\/backups(?:\/|$)/.test(c.req.path);
        if (shuttingDown) {
            c.header("Connection", "close");
        }
        try {
            if (shuttingDown && (resource || backup)) {
                c.header("Retry-After", "5");
                c.header("Cache-Control", "no-store");
                return c.json({ error: "The server is shutting down" }, 503);
            }
            if (resource) {
                await snapshots.track(next);
            } else {
                await next();
            }
        } finally {
            if (shuttingDown) {
                c.header("Connection", "close");
            }
        }
    });

    // The backup import streams its body to disk with its own cap; Hono's limiter would buffer it.
    const limitBody = bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
    app.use((c, next) =>
        c.req.method === "POST" && c.req.path.replace(/\/+$/, "") === BACKUP_IMPORT_PATH ? next() : limitBody(c, next),
    );

    // Serves the client with the flag that makes `isNodeServer` true. Without it the client shows only a
    // "self-host server required" notice, so `/index.html` must not fall through to the raw static file.
    const serveIndex = async (c: Context<AppEnv>) => {
        const clientIP =
            c.req.header("x-forwarded-for") || clientIp(c) || c.env?.incoming?.socket?.remoteAddress || "Unknown IP";
        console.log(`[Server] ${new Date().toISOString()} | Connection from: ${clientIP}`);

        const mainIndex = await fs.readFile(path.join(distPath, "index.html"), "utf-8");
        if (!headOpenTag.test(mainIndex)) {
            throw new Error("dist/index.html has no <head>");
        }
        return c.html(mainIndex.replace(headOpenTag, (tag) => `${tag}<script>globalThis.__NODE__ = true</script>`));
    };
    app.get("/", serveIndex);
    app.get("/index.html", serveIndex);

    app.get("*", serveStatic({ root: distPath }));

    registerProxyRoutes(app, { auth, limiter: authenticatedRouteLimiter.middleware, clientIp });
    proxyStreamJobs.registerRoutes(app, { limiter: authenticatedRouteLimiter.middleware, clientIp });
    registerGenerationRoutes(app, { jobs: generationJobs, auth, limiter: authenticatedRouteLimiter.middleware });
    auth.registerRoutes(app, { auth: authRouteLimiter.middleware, login: loginRouteLimiter.middleware });
    registerStorageRoutes(app, {
        savePath,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maintenance: snapshots.gate,
    });
    registerResourceRoutes(app, {
        store: resources,
        kinds: resourceKinds,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maintenance: snapshots.gate,
    });
    registerBackupRoutes(app, {
        savePath,
        store: resources,
        snapshots,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maxImportBytes,
    });

    return {
        app,
        snapshots,
        scriptWorkers,
        beginShutdown,
        generationJobs,
        /** Installs the one `upgrade` dispatcher: proxy stream jobs, generation jobs, else the socket is destroyed. */
        attachWebSocket: (server: http.Server) => {
            if (shuttingDown || upgradeListeners.has(server)) {
                return;
            }
            const listener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
                if (
                    !proxyStreamJobs.handleUpgrade(req, socket, head) &&
                    !generationJobs.handleUpgrade(req, socket, head)
                ) {
                    socket.destroy();
                }
            };
            server.on("upgrade", listener);
            upgradeListeners.set(server, listener);
        },
        startBackgroundTasks: () => {
            proxyStreamJobs.startGc();
            generationJobs.startGc();
            snapshots.start();
        },
        /**
         * Begins shutdown (every generation job is aborted), waits for the jobs to end (bounded by
         * their abort deadline), disposes the script workers, waits for admitted resource handlers
         * and backup operations, then closes the store. The HTTP entrypoint drains connections before
         * calling this; in-process callers can use it alone. Calling it again returns the same promise.
         */
        dispose: () => {
            beginShutdown();
            disposing ??= generationJobs
                .drain()
                .then(() => generationJobs.dispose())
                .then(() => scriptWorkers.dispose())
                .then(() => snapshots.stop())
                .then(() => resources.close());
            return disposing;
        },
    };
}

function parseMaxImportBytes(raw: string | undefined): number {
    if (raw === undefined || raw === "") {
        return DEFAULT_MAX_IMPORT_BYTES;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid RISU_MAX_IMPORT_BYTES: ${raw}`);
    }
    return value;
}
