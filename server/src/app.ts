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
import { createChangeFeed } from "./data/changeFeed.ts";
import { createResourceStore, ResourceStoreClosedError } from "./data/resourceStore.ts";
import { createSnapshotManager, MaintenanceError } from "./data/snapshots.ts";
import { createVectorCache } from "./data/vectorCache.ts";
import { compileTrust, getClientIp, parseTrustProxyEnv } from "./http/clientIp.ts";
import { createRateLimiter } from "./http/rateLimit.ts";
import { createGenerationRunner } from "./jobs/commandRunner.ts";
import type { GenerationRunnerDeps } from "./jobs/runSetup.ts";
import { createGenerationJobs, type GenerationRunner } from "./jobs/generationJobs.ts";
import { createGenerationLock } from "./jobs/generationLock.ts";
import { createClaudeObserver } from "./llm/claudeObserver.ts";
import { createLlmRequests } from "./llm/requests.ts";
import { createVertexTokenCache } from "./llm/vertexToken.ts";
import { createEmbeddings } from "./prompt/embeddings.ts";
import { createMcpRegistry } from "./mcp/registry.ts";
import { createTokenizers } from "./prompt/tokenizers/index.ts";
import { createTokenCounter } from "./prompt/tokens.ts";
import { createTransformers } from "./prompt/transformers.ts";
import { createAuthStore } from "./routes/auth.ts";
import { BACKUP_IMPORT_PATH, DEFAULT_MAX_IMPORT_BYTES, registerBackupRoutes } from "./routes/backups.ts";
import { registerGenerationRoutes } from "./routes/generations.ts";
import { registerTransformRoutes, TRANSFORM_PATHS } from "./routes/transform.ts";
import { registerTranslateRoutes, TRANSLATE_MESSAGE_PATH } from "./routes/translate.ts";
import { createTranslationRunner } from "./translation/runner.ts";
import { createTransformService } from "./prompt/transform.ts";
import { registerLlmRoutes } from "./routes/llm.ts";
import { registerLlmSecretRoutes } from "./routes/llmSecrets.ts";
import { registerProxyRoutes } from "./routes/proxy.ts";
import { createEventSockets } from "./routes/events.ts";
import { registerResourceRoutes } from "./routes/resources.ts";
import { registerStorageRoutes } from "./routes/storage.ts";
import { createScriptWorkerPool } from "./scripts/workerPool.ts";
import { RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../shared/resources.ts";
import { isClientRoutePath } from "../../shared/routes.ts";
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
 * the generation jobs (tests inject one; the default runs `command` jobs and the sends and previews
 * of prompt assembly), and `generationRandom` is the default runner's random source.
 */
export function createServerContext(options: {
    rootDir: string;
    trustProxy?: string;
    resourceKinds?: readonly ResourceKind[];
    snapshotIntervalMs?: number;
    maxImportBytes?: number;
    generationRunner?: GenerationRunner;
    /** The default runner's random source (`presetChain`, the group order); default `Math.random`. */
    generationRandom?: () => number;
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
    // Every committed change goes to the live-update sockets (Phase 6).
    const changeFeed = createChangeFeed();
    // `save/data/` is not a storage namespace, so the `/api/*` storage routes cannot reach the file.
    const resources = createResourceStore({
        file: path.join(savePath, "data", "resources.sqlite"),
        kinds: resourceKinds,
        guard: generationLock,
        feed: changeFeed,
    });
    const eventSockets = createEventSockets({
        feed: changeFeed,
        epoch: () => resources.epoch(),
        authorize: auth.isAuthorizedToken,
    });
    const snapshots = createSnapshotManager({
        store: resources,
        dir: path.join(savePath, "backups"),
        intervalMs: options.snapshotIntervalMs,
    });
    const maxImportBytes = options.maxImportBytes ?? parseMaxImportBytes(process.env.RISU_MAX_IMPORT_BYTES);
    // The server translations' maintenance listener is the first one (the runner is built below; a
    // maintenance runs only once the context exists): admission closes and every run ends (503)
    // before the jobs' listener waits for their end, and before the request layer's pause fails a
    // run's request.
    snapshots.onMaintenance(async () => {
        translationRunner.pause("The server data is being replaced");
        return () => translationRunner.resume();
    });
    const generationJobs = createGenerationJobs({
        store: resources,
        kinds: resourceKinds,
        gate: snapshots.gate,
        snapshots,
        lock: generationLock,
        authorize: auth.isAuthorizedToken,
        // The default runner is built below (it needs the request layer and the script workers);
        // a job starts only after the context exists.
        runner: options.generationRunner ?? ((job) => defaultRunner(job)),
    });
    // The server request layer (`POST /api/llm/request`): its tokenizers load on first use.
    const tokenizers = createTokenizers({ rootDir: options.rootDir });
    const tokenCounter = createTokenCounter({ tokenizers });
    // Memory on the server (Phase 5 slice 10): the embedding vectors are a cache in a file of their
    // own (in no snapshot or archive; `save/data/` and `save/models/` are not storage namespaces), and
    // the local models run in a child process that starts with the first task.
    const vectorCache = createVectorCache({ file: path.join(savePath, "data", "vectors.sqlite") });
    // The vectors of another database (a restore or an import while the server was down) are dropped.
    vectorCache.sync(resources.epoch());
    const transformers = createTransformers({ cacheDir: path.join(savePath, "models", "transformers") });
    const embeddings = createEmbeddings({ cache: vectorCache, transformers });
    const llmRequests = createLlmRequests({
        store: resources,
        kinds: resourceKinds,
        tokens: tokenCounter,
        vertexTokens: createVertexTokenCache(),
        claudeObserver: createClaudeObserver(),
        // A job's request to a local Transformers.js model (`LLMFormat.WebLLM`) runs in that process.
        localGeneration: (text, model, config, signal) => transformers.runTextGeneration(text, model, config, signal),
        parentCallback: (jobId, clientId, callbackId, onSettled) =>
            generationJobs.parentCallback(jobId, clientId, callbackId, onSettled),
    });
    // The server translations (`POST /api/translate/message`) run through the request layer.
    const translationRunner = createTranslationRunner({
        store: resources,
        kinds: resourceKinds,
        gate: snapshots.gate,
        lock: generationLock,
        llm: llmRequests,
        tokens: tokenCounter,
        rootDir: options.rootDir,
    });
    // A restore or an import replaces the settings: live requests end, new ones wait (503).
    snapshots.onMaintenance(async () => {
        llmRequests.pause("The server data is being replaced");
        return () => llmRequests.resume();
    });
    // The vectors belong to the data: when a maintenance replaced it (a new epoch), the cache is
    // emptied as the maintenance ends, and a write of work that began before is dropped.
    snapshots.onMaintenance(async () => () => vectorCache.sync(resources.epoch()));
    // The remote MCP clients of the jobs (Phase 5 slice 12): their sessions and tokens live in this
    // process and belong to the data they were made with.
    const mcpRegistry = createMcpRegistry({ store: resources, kinds: resourceKinds });
    mcpRegistry.sync(resources.epoch());
    snapshots.onMaintenance(async () => () => mcpRegistry.sync(resources.epoch()));
    const llmSecretsKind = resourceKinds.get(RESOURCE_KIND.llmSecrets);

    /** The one `upgrade` listener per HTTP server (generation jobs, live updates). */
    const upgradeListeners = new Map<http.Server, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void>();
    // Workers start on the first task: Lua buttons and manual triggers (`command` jobs) run there.
    const scriptWorkers = createScriptWorkerPool({ rootDir: options.rootDir });
    const runnerDeps: GenerationRunnerDeps = {
        store: resources,
        kinds: resourceKinds,
        rootDir: options.rootDir,
        savePath,
        scriptWorkers,
        llm: llmRequests,
        tokens: tokenCounter,
        embeddings,
        transformers,
        mcp: mcpRegistry,
        lock: generationLock,
        translations: translationRunner,
        ...(options.generationRandom ? { random: options.generationRandom } : {}),
    };
    const defaultRunner = createGenerationRunner(runnerDeps);
    // The script transform (Phase 5 slice 13): read-only renders on the runner's services. A restore
    // or an import stops every render and empties its cache (the data it was made from is gone).
    const transforms = createTransformService(runnerDeps);
    snapshots.onMaintenance(async () => transforms.pause("The server data is being replaced"));

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
        translationRunner.beginShutdown();
        llmRequests.beginShutdown();
        for (const [server, listener] of upgradeListeners) {
            server.off("upgrade", listener);
        }
        upgradeListeners.clear();
        // Before the snapshot manager stops: the clients see the server going away (1001) and reconnect.
        eventSockets.close();
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
        // The credential writes (`/api/llm-secrets`) are resource writes too.
        const resource = /^\/api\/(?:resources|llm-secrets)(?:\/|$)/.test(c.req.path);
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
    // The script transform's and the translation's routes authenticate first and cap their bodies
    // themselves (8 MiB, 16 KiB).
    app.use((c, next) => {
        const route = c.req.path.replace(/\/+$/, "");
        return c.req.method === "POST" &&
            (route === BACKUP_IMPORT_PATH || route === TRANSLATE_MESSAGE_PATH || TRANSFORM_PATHS.includes(route))
            ? next()
            : limitBody(c, next);
    });

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
    // The client's screen routes (`shared/routes.ts`) get the client too, so a reload or a link lands
    // on that screen. Every path under those five first segments gets it (the client rejects one that
    // names no screen); any other unknown path or asset miss stays a 404.
    app.get("*", (c, next) => (isClientRoutePath(c.req.path) ? serveIndex(c) : next()));

    app.get("*", serveStatic({ root: distPath }));

    registerProxyRoutes(app, {
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        clientIp,
        llmSecrets: () =>
            llmSecretsKind
                ? ((resources.get(llmSecretsKind, SINGLETON_RESOURCE_ID)?.data as
                      Record<string, unknown> | undefined) ?? null)
                : null,
    });
    registerGenerationRoutes(app, { jobs: generationJobs, auth, limiter: authenticatedRouteLimiter.middleware });
    registerTransformRoutes(app, {
        transforms,
        store: resources,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
    });
    registerTranslateRoutes(app, {
        runner: translationRunner,
        store: resources,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
    });
    registerLlmRoutes(app, {
        requests: llmRequests,
        store: resources,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
    });
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
    registerLlmSecretRoutes(app, {
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
        llmRequests,
        translationRunner,
        eventSockets,
        /**
         * Installs the one `upgrade` dispatcher: generation jobs, the live-update socket, else the
         * socket is destroyed.
         */
        attachWebSocket: (server: http.Server) => {
            if (shuttingDown || upgradeListeners.has(server)) {
                return;
            }
            const listener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
                if (
                    !generationJobs.handleUpgrade(req, socket, head) &&
                    !eventSockets.handleUpgrade(req, socket, head)
                ) {
                    socket.destroy();
                }
            };
            server.on("upgrade", listener);
            upgradeListeners.set(server, listener);
        },
        startBackgroundTasks: () => {
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
            disposing ??= Promise.all([
                generationJobs.drain(),
                translationRunner.drain(),
                llmRequests.dispose(),
                transforms.close(),
            ])
                .then(() => generationJobs.dispose())
                .then(() => tokenizers.dispose())
                .then(() => scriptWorkers.dispose())
                .then(() => transformers.dispose())
                .then(() => mcpRegistry.dispose())
                .then(() => vectorCache.close())
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
