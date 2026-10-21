import type { Credential, Database, ModelProfile } from "../../shared/database.ts";
import { credentialSlotOf } from "../../shared/llm/credentialSlots.ts";
import { resolveModelInfo } from "../../shared/llm/models.ts";
import { resolveCredential } from "./llm/credentials.ts";
import { mkdirSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import type { Duplex } from "node:stream";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "./data/kinds.ts";
import { createChangeFeed } from "./data/changeFeed.ts";
import { createResourceStore, ResourceStoreClosedError } from "./data/resourceStore.ts";
import { createSnapshotManager, MaintenanceError } from "./data/snapshots.ts";
import { clampRequestHistoryLimit, createRequestHistory, REQUEST_HISTORY_MAX_BYTES } from "./data/requestHistory.ts";
import { createVectorCache } from "./data/vectorCache.ts";
import { createDiagnosticsJournal, DIAGNOSTICS_MAX_BYTES } from "./diagnostics/journal.ts";
import { createRequestShares } from "./diagnostics/share.ts";
import { errorFields } from "./diagnostics/log.ts";
import { createHistoryObserver } from "./llm/historyObserver.ts";
import { compileTrust, getClientIp, parseTrustProxyEnv } from "./http/clientIp.ts";
import { createImportSlot } from "./http/fileImport.ts";
import { createRateLimiter } from "./http/rateLimit.ts";
import { createGenerationRunner } from "./jobs/commandRunner.ts";
import type { GenerationRunnerDeps } from "./jobs/runSetup.ts";
import { createGenerationJobs, type GenerationRunner } from "./jobs/generationJobs.ts";
import { createGenerationLock } from "./jobs/generationLock.ts";
import { createClaudeObserver } from "./llm/claudeObserver.ts";
import { createLlmRequests } from "./llm/requests.ts";
import { loadStoredSecrets, mergeCredentials } from "./llm/settings.ts";
import { createVertexTokenCache } from "./llm/vertexToken.ts";
import { createEmbeddings } from "./prompt/embeddings.ts";
import { createMcpRegistry } from "./mcp/registry.ts";
import { createTokenizers } from "./prompt/tokenizers/index.ts";
import { createTokenCounter } from "./prompt/tokens.ts";
import { createTransformers } from "./prompt/transformers.ts";
import { createAuthStore } from "./routes/auth.ts";
import { BACKUP_IMPORT_PATH, DEFAULT_MAX_IMPORT_BYTES, registerBackupRoutes } from "./routes/backups.ts";
import { createUpstreamImportStaging, registerUpstreamImportRoutes } from "./routes/backupsUpstream.ts";
import { createUpstreamExportStaging, registerUpstreamExportRoutes } from "./routes/backupsUpstreamExport.ts";
import { UPSTREAM_IMPORT_PREPARE_PATH } from "../../shared/upstreamBackup.ts";
import {
    DEFAULT_MAX_UPSTREAM_DB_BYTES,
    defaultUpstreamImportHeapMb,
    type UpstreamImportRunner,
} from "./data/upstream/importRunner.ts";
import { registerGenerationRoutes } from "./routes/generations.ts";
import { CHARX_IMPORT_PATH, registerCharxImportRoutes } from "./routes/importCharx.ts";
import { MODULE_IMPORT_PATH, registerModuleImportRoutes } from "./routes/importModule.ts";
import {
    MESSAGE_SEARCH_PATH,
    type MessageSearchRouteOptions,
    registerMessageSearchRoutes,
} from "./routes/messageSearch.ts";
import {
    createRealmStaging,
    REALM_CANCEL_PATH,
    REALM_COMMIT_PATH,
    REALM_IMPORT_PATH,
    type RealmStagingTimer,
    registerRealmImportRoutes,
} from "./routes/importRealm.ts";
import { registerTransformRoutes, TRANSFORM_PATHS } from "./routes/transform.ts";
import { registerTranslateRoutes, TRANSLATE_MESSAGE_PATH } from "./routes/translate.ts";
import { createTranslationRunner } from "./translation/runner.ts";
import { createTransformService } from "./prompt/transform.ts";
import { registerLlmRoutes } from "./routes/llm.ts";
import { registerLlmSecretRoutes } from "./routes/llmSecrets.ts";
import { registerProxyRoutes } from "./routes/proxy.ts";
import {
    REQUEST_HISTORY_PATH,
    REQUEST_HISTORY_SHARE_PATH,
    registerRequestHistoryRoutes,
} from "./routes/requestHistory.ts";
import { DIAGNOSTICS_PATH, DIAGNOSTICS_REPORT_PATH, registerDiagnosticsRoutes } from "./routes/diagnostics.ts";
import { PUSH_SUBSCRIPTION_PATH, registerPushRoutes } from "./routes/push.ts";
import { createPushService, type PushTransport } from "./push/pushService.ts";
import { createEventSockets } from "./routes/events.ts";
import { registerResourceRoutes } from "./routes/resources.ts";
import { registerStorageRoutes } from "./routes/storage.ts";
import { createScriptWorkerPool, type ScriptWorkerPoolOptions } from "./scripts/workerPool.ts";
import { RESOURCE_BOOT_PATH, RESOURCE_KIND, SINGLETON_RESOURCE_ID } from "../../shared/resources.ts";
import { isClientRoutePath } from "../../shared/routes.ts";
import type { AppEnv } from "./types.ts";

const MAX_BODY_BYTES = 100 * 1024 * 1024;
/** An answer slower than this is an `http` diagnostic event whatever its status. */
const HTTP_SLOW_MS = 5_000;
const headOpenTag = /<head(\s[^>]*)?>/i;

export type ServerContext = ReturnType<typeof createServerContext>;

/**
 * Builds the self-host server: `rootDir/dist` is the built client, `rootDir/save` the storage
 * (`savePath` replaces it: `RISU_SAVE_DIR`, the `pnpm dev:agent` sandbox). `authBypass` lets every
 * protected route through without a login (`createAuthStore`); `main.ts` allows it on loopback only.
 * All state (password, known keys, stream jobs, rate-limit counters, the resource database and its
 * snapshots) lives in the returned context. `resourceKinds` replaces the default resource kinds and
 * `snapshotIntervalMs` the 10-minute snapshot interval (tests use them); `maxImportBytes` caps an
 * uploaded backup archive or module file (default `RISU_MAX_IMPORT_BYTES`, else 16 GiB).
 * `generationRunner` runs the generation jobs (tests inject one; the default runs `command` jobs
 * and the sends and previews of prompt assembly), and `generationRandom` is the default runner's
 * random source. `messageSearch` replaces the message search's limits and its yield between batches
 * (tests inject a latch). `realmStagingTimer`, `generationEffectClock`, and `generationAbortGraceMs`
 * replace the staged Realm imports' expiry timer, the trigger effect loop's clock, and an aborted job's
 * grace (tests control them; the defaults are the production ones).
 */
export function createServerContext(options: {
    rootDir: string;
    savePath?: string;
    authBypass?: boolean;
    trustProxy?: string;
    resourceKinds?: readonly ResourceKind[];
    snapshotIntervalMs?: number;
    /** The script workers' watchdog and abort graces (tests change them; the defaults are the production ones). */
    scriptWorkerOptions?: Pick<ScriptWorkerPoolOptions, "watchdogGraceMs" | "abortGraceMs">;
    maxImportBytes?: number;
    generationRunner?: GenerationRunner;
    /** The default runner's random source (`presetChain`, the group order); default `Math.random`. */
    generationRandom?: () => number;
    /** Web Push delivery (tests inject one; the default is `web-push`). */
    pushTransport?: PushTransport;
    /**
     * The Realm download's origin, the `/hub-proxy` target, and how long a staged Realm import waits
     * for its commit (tests replace them).
     */
    realm?: { downloadOrigin?: string; hubURL?: string; stagedTtlMs?: number };
    /**
     * The upstream RisuAI import (`routes/backupsUpstream.ts`): how long a prepared import waits for its
     * commit, and what runs a prepare (tests replace them; the default is a worker per import).
     */
    upstreamImport?: { stagedTtlMs?: number; runner?: UpstreamImportRunner };
    /** The upstream RisuAI-compatible export (`routes/backupsUpstreamExport.ts`): how long a prepared export waits for its download. */
    upstreamExport?: { stagedTtlMs?: number };
    messageSearch?: MessageSearchRouteOptions;
    /** What schedules a staged Realm import's expiry (tests hold it; default an unref'd `setTimeout`). */
    realmStagingTimer?: RealmStagingTimer;
    /** The default runner's trigger effect-loop clock for its 50 ms yield (default `performance.now`). */
    generationEffectClock?: () => number;
    /** An aborted generation job's grace before it is ended for it (default `JOB_ABORT_GRACE_MS`, 5 s). */
    generationAbortGraceMs?: number;
}) {
    const savePath = options.savePath ?? path.join(options.rootDir, "save");
    const distPath = path.join(options.rootDir, "dist");
    mkdirSync(savePath, { recursive: true });

    const trust = compileTrust(parseTrustProxyEnv(options.trustProxy));
    const clientIp = (c: Parameters<typeof getClientIp>[0]) => getClientIp(c, trust);

    const auth = createAuthStore(savePath, { bypass: options.authBypass });
    const resourceKinds = createKindRegistry(options.resourceKinds ?? DEFAULT_RESOURCE_KINDS);
    let appVersion: string | null | undefined;
    // The diagnostics folder: content-free events and `state.json`, which the developer pulls over
    // sftp. Its state sources are read only after the context is built (the boot state below, the
    // timers, an error event).
    const diagnostics = createDiagnosticsJournal({
        dir: process.env.RISU_DIAGNOSTICS_DIR
            ? path.resolve(options.rootDir, process.env.RISU_DIAGNOSTICS_DIR)
            : path.join(savePath, "diagnostics"),
        maxBytes: parseDiagnosticsMaxBytes(process.env.RISU_DIAGNOSTICS_MAX_BYTES),
        sources: {
            appVersion: () => {
                if (appVersion === undefined) {
                    appVersion = readAppVersion(options.rootDir);
                }
                return appVersion;
            },
            settings: () => {
                const providers = readProviders();
                return {
                    requestHistoryContent: providers?.requestHistoryContent !== false,
                    requestHistoryLimit: clampRequestHistoryLimit(providers?.requestHistoryLimit),
                };
            },
            history: () => requestHistory.stats(),
            workers: () => scriptWorkers.stats(),
            liveJobs: () => generationJobs.live(),
        },
    });
    // The store consults the lock on every write that could rewrite or remove a job's message.
    const generationLock = createGenerationLock();
    // Every committed change goes to the live-update sockets.
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
    // The Realm imports staged by a prepare and waiting for their commit (`routes/importRealm.ts`).
    const realmStaging = createRealmStaging({ ttlMs: options.realm?.stagedTtlMs, timer: options.realmStagingTimer });
    // The upstream imports prepared and waiting for their commit (`routes/backupsUpstream.ts`).
    const upstreamStaging = createUpstreamImportStaging({ ttlMs: options.upstreamImport?.stagedTtlMs });
    // The upstream exports prepared and waiting for their download (`routes/backupsUpstreamExport.ts`).
    const upstreamExportStaging = createUpstreamExportStaging({ ttlMs: options.upstreamExport?.stagedTtlMs });
    // Before every other maintenance listener, so its start is the first thing recorded; it never
    // throws. Its end says whether the data was replaced (a new epoch).
    snapshots.onMaintenance(async () => {
        const epoch = resources.epoch();
        diagnostics.record({ kind: "lifecycle", phase: "maintenanceStart" });
        return () =>
            diagnostics.record({ kind: "lifecycle", phase: "maintenanceEnd", replaced: resources.epoch() !== epoch });
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
        diagnostics,
        abortGraceMs: options.generationAbortGraceMs,
    });
    // The server request layer (`POST /api/llm/request`): its tokenizers load on first use.
    const tokenizers = createTokenizers({ rootDir: options.rootDir });
    const tokenCounter = createTokenCounter({ tokenizers });
    // Memory on the server: the embedding vectors are a cache in a file of their own (in no snapshot
    // or archive; `save/data/` and `save/models/` are not storage namespaces), and the local models
    // run in a child process that starts with the first task.
    const vectorCache = createVectorCache({ file: path.join(savePath, "data", "vectors.sqlite") });
    // The vectors of another database (a restore or an import while the server was down) are dropped.
    vectorCache.sync(resources.epoch());
    // The LLM request history: diagnostic data in a file of its own, in no snapshot (they copy only
    // `resources.sqlite`) or archive; a restore, an import, or a maintenance leaves it as it is. Its
    // two settings are `providers` fields, read where they apply: the row cap at every prune (a read
    // that throws skips that prune), content capture when a request begins. A record or field not
    // there yet reads as its default.
    const providersKind = resourceKinds.get(RESOURCE_KIND.providers);
    const readProviders = (): Record<string, unknown> | undefined =>
        providersKind
            ? (resources.get(providersKind, SINGLETON_RESOURCE_ID)?.data as Record<string, unknown> | undefined)
            : undefined;
    const requestHistory = createRequestHistory({
        file: path.join(savePath, "data", "request-history.sqlite"),
        maxBytes: parseRequestHistoryMaxBytes(process.env.RISU_REQUEST_HISTORY_MAX_BYTES),
        limit: () => clampRequestHistoryLimit(readProviders()?.requestHistoryLimit),
    });
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
        // Every admitted request writes its history row, with its content unless the setting is off.
        observer: createHistoryObserver(requestHistory, {
            content: () => readProviders()?.requestHistoryContent !== false,
            diagnostics,
        }),
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
    // The remote MCP clients of the jobs: their sessions and tokens live in this process and belong
    // to the data they were made with.
    const mcpRegistry = createMcpRegistry({ store: resources, kinds: resourceKinds });
    mcpRegistry.sync(resources.epoch());
    snapshots.onMaintenance(async () => () => mcpRegistry.sync(resources.epoch()));
    const llmSecretsKind = resourceKinds.get(RESOURCE_KIND.llmSecrets);

    /** The one `upgrade` listener per HTTP server (generation jobs, live updates). */
    const upgradeListeners = new Map<http.Server, (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void>();
    // Workers start on the first task: Lua buttons and manual triggers (`command` jobs) run there.
    const scriptWorkers = createScriptWorkerPool({ rootDir: options.rootDir, ...options.scriptWorkerOptions });
    // Web Push for chat completions: its keys and subscriptions live in `save/server/`, beside the
    // password.
    const push = createPushService({
        savePath,
        ...(options.pushTransport ? { transport: options.pushTransport } : {}),
    });
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
        push,
        diagnostics,
        ...(options.generationRandom ? { random: options.generationRandom } : {}),
        ...(options.generationEffectClock ? { effectClock: options.generationEffectClock } : {}),
    };
    const defaultRunner = createGenerationRunner(runnerDeps);
    // The script transform: read-only renders on the runner's services. A restore
    // or an import stops every render and empties its cache (the data it was made from is gone).
    const transforms = createTransformService(runnerDeps);
    snapshots.onMaintenance(async () => transforms.pause("The server data is being replaced"));

    const authenticatedRouteLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2000,
        message: "Too many requests. Please retry shortly.",
        keyOf: clientIp,
    });
    // The storage routes (`/api/read`, `/api/write`, `/api/assets/*`, ...) have their own bucket, so a
    // burst of asset reads or writes (a module import or export) cannot 429 resource sync and the rest.
    const storageRouteLimiter = createRateLimiter({
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
        diagnostics.record({ kind: "lifecycle", phase: "shutdown" });
        // Time zero of every job's abort deadline; `dispose` waits for them to end.
        generationJobs.beginShutdown();
        translationRunner.beginShutdown();
        llmRequests.beginShutdown();
        push.close();
        // The staged Realm imports waiting for their commit are removed (a running commit is tracked).
        void realmStaging.close();
        // A running upstream prepare ends now (its worker is terminated), not after the HTTP drain, and
        // the prepared imports are removed (a running commit is tracked).
        void upstreamStaging.close();
        // The prepared exports waiting for their download are removed (a running download is tracked).
        void upstreamExportStaging.close();
        for (const [server, listener] of upgradeListeners) {
            server.off("upgrade", listener);
        }
        upgradeListeners.clear();
        // Before the snapshot manager stops: the clients see the server going away (1001) and reconnect.
        eventSockets.close();
        authenticatedRouteLimiter.dispose();
        storageRouteLimiter.dispose();
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

    // An `http` diagnostic event for an error answer (400 and up) or a slow one (the time to the
    // response, not to the end of a streamed body). The route is the template of the last registered
    // handler that ran (a route's own auth or limiter included; `*` for a miss), never the URL.
    let registeredRoutes: Set<string> | null = null;
    app.use(async (c, next) => {
        const started = performance.now();
        let threw = false;
        try {
            await next();
        } catch (error) {
            threw = true;
            throw error;
        } finally {
            const durationMs = Math.round(performance.now() - started);
            const status = threw ? 500 : c.res.status;
            if (status >= 400 || durationMs > HTTP_SLOW_MS) {
                registeredRoutes ??= new Set(app.routes.map((route) => route.path));
                const route = routePath(c);
                diagnostics.record({
                    kind: "http",
                    method: c.req.method,
                    route: registeredRoutes.has(route) ? route : "?",
                    status,
                    durationMs,
                });
            }
        }
    });

    // Admit resource handlers before their first await (including body parsing and auth). Tracking
    // them also makes in-process dispose safe; maintenance only waits for storage-gate admissions.
    app.use(async (c, next) => {
        // The credential writes (`/api/llm-secrets`) are resource writes too, and the message search
        // reads the resource store between yields (shutdown waits for it before closing the store).
        const resource =
            /^\/api\/(?:resources|llm-secrets)(?:\/|$)/.test(c.req.path) ||
            c.req.path.replace(/\/+$/, "") === MESSAGE_SEARCH_PATH;
        const backup = /^\/api\/backups(?:\/|$)/.test(c.req.path);
        // The module, CharX, and Realm imports are refused like the backup routes.
        const fileImportRoute = c.req.path.replace(/\/+$/, "");
        const fileImport =
            fileImportRoute === MODULE_IMPORT_PATH ||
            fileImportRoute === CHARX_IMPORT_PATH ||
            fileImportRoute === REALM_IMPORT_PATH ||
            fileImportRoute === REALM_COMMIT_PATH ||
            fileImportRoute === REALM_CANCEL_PATH;
        // The request history and the diagnostics: refused during shutdown (the history's store closes at
        // dispose), and every answer is `no-store`, the limiter's 429 and the body limit's 413 included.
        const history =
            c.req.path === REQUEST_HISTORY_PATH ||
            c.req.path.startsWith(`${REQUEST_HISTORY_PATH}/`) ||
            c.req.path.replace(/\/+$/, "") === DIAGNOSTICS_PATH ||
            c.req.path.startsWith(`${DIAGNOSTICS_PATH}/`);
        if (shuttingDown) {
            c.header("Connection", "close");
        }
        try {
            if (shuttingDown && (resource || backup || fileImport || history)) {
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
            if (history) {
                c.header("Cache-Control", "no-store");
            }
        }
    });

    // The backup (version-2 and upstream), module, and CharX imports stream their bodies to disk with
    // their own cap; Hono's limiter would buffer them.
    const limitBody = bodyLimit({
        maxSize: MAX_BODY_BYTES,
        onError: (c) => c.json({ error: "Request body too large" }, 413),
    });
    // The script transform's, the translation's, the push subscription's, the diagnostic report's, the
    // request history share's, the Realm import's routes (prepare, commit, cancel), the boot read's, and
    // the message search's cap their bodies themselves (8 MiB, 16 KiB, 16 KiB, 1 MiB, 4 KiB, 4 KiB,
    // 2 MiB, 4 KiB).
    app.use((c, next) => {
        const route = c.req.path.replace(/\/+$/, "");
        const ownLimit =
            (c.req.method === "POST" &&
                (route === BACKUP_IMPORT_PATH ||
                    route === UPSTREAM_IMPORT_PREPARE_PATH ||
                    route === MODULE_IMPORT_PATH ||
                    route === CHARX_IMPORT_PATH ||
                    route === REALM_IMPORT_PATH ||
                    route === REALM_COMMIT_PATH ||
                    route === REALM_CANCEL_PATH ||
                    route === TRANSLATE_MESSAGE_PATH ||
                    route === DIAGNOSTICS_REPORT_PATH ||
                    route === MESSAGE_SEARCH_PATH ||
                    TRANSFORM_PATHS.includes(route))) ||
            (c.req.method === "POST" && c.req.path === RESOURCE_BOOT_PATH) ||
            ((c.req.method === "PUT" || c.req.method === "DELETE") && route === PUSH_SUBSCRIPTION_PATH) ||
            (c.req.method === "PUT" && route === REQUEST_HISTORY_SHARE_PATH);
        return ownLimit ? next() : limitBody(c, next);
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
        hubURL: options.realm?.hubURL,
        llmSecrets: () =>
            llmSecretsKind
                ? ((resources.get(llmSecretsKind, SINGLETON_RESOURCE_ID)?.data as
                      Record<string, unknown> | undefined) ?? null)
                : null,
        auxCredential: (profileId) => {
            const read = resources.readRefs(
                [
                    RESOURCE_KIND.modelProfiles,
                    RESOURCE_KIND.credentials,
                    RESOURCE_KIND.llmSecrets,
                    RESOURCE_KIND.customModels,
                ].map((name) => ({ kind: resourceKinds.get(name)!, id: SINGLETON_RESOURCE_ID })),
            );
            const [profiles, records, secrets, customModels] = read.items.map((item) => item.data);
            const profile = (profiles as ModelProfile[] | null)?.find((entry) => entry.id === profileId);
            if (!profile) return { error: "The model profile no longer exists" };
            const modelInfo = resolveModelInfo(profile.modelId, {
                customModels: (customModels ?? []) as Database["customModels"],
            });
            return {
                slot: credentialSlotOf(profile.modelId, modelInfo)?.slot ?? null,
                credential: resolveCredential(
                    {
                        credentials: mergeCredentials(
                            (records ?? []) as Credential[],
                            (secrets ?? {}) as Record<string, unknown>,
                        ),
                    },
                    profile.modelId,
                    modelInfo,
                    profile,
                ),
            };
        },
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
    registerPushRoutes(app, { push, auth, limiter: authenticatedRouteLimiter.middleware });
    registerLlmRoutes(app, {
        requests: llmRequests,
        store: resources,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
    });
    registerRequestHistoryRoutes(app, {
        history: requestHistory,
        // A job's requests shared to the diagnostics folder, redacted again with every credential
        // stored now.
        shares: createRequestShares({
            history: requestHistory,
            journal: diagnostics,
            secrets: () => loadStoredSecrets(resources, resourceKinds),
        }),
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        shuttingDown: () => shuttingDown,
    });
    registerDiagnosticsRoutes(app, {
        journal: diagnostics,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        shuttingDown: () => shuttingDown,
    });
    auth.registerRoutes(app, { auth: authRouteLimiter.middleware, login: loginRouteLimiter.middleware });
    registerStorageRoutes(app, {
        savePath,
        auth,
        limiter: storageRouteLimiter.middleware,
        maintenance: snapshots.gate,
    });
    registerResourceRoutes(app, {
        store: resources,
        kinds: resourceKinds,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maintenance: snapshots.gate,
    });
    registerMessageSearchRoutes(app, {
        store: resources,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maintenance: snapshots.gate,
        limits: options.messageSearch,
    });
    registerLlmSecretRoutes(app, {
        store: resources,
        kinds: resourceKinds,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maintenance: snapshots.gate,
    });
    // One archive import at a time: the version-2 import and the upstream prepare and commit share it.
    const backupImportSlot = createImportSlot();
    registerBackupRoutes(app, {
        savePath,
        store: resources,
        snapshots,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maxImportBytes,
        diagnostics,
        slot: backupImportSlot,
    });
    const maxUpstreamDatabaseBytes = parsePositiveInteger(
        "RISU_MAX_UPSTREAM_DB_BYTES",
        process.env.RISU_MAX_UPSTREAM_DB_BYTES,
        DEFAULT_MAX_UPSTREAM_DB_BYTES,
    );
    registerUpstreamImportRoutes(app, {
        savePath,
        store: resources,
        snapshots,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maxImportBytes,
        slot: backupImportSlot,
        diagnostics,
        staging: upstreamStaging,
        maxDatabaseBytes: maxUpstreamDatabaseBytes,
        heapMb: parsePositiveInteger(
            "RISU_UPSTREAM_IMPORT_HEAP_MB",
            process.env.RISU_UPSTREAM_IMPORT_HEAP_MB,
            defaultUpstreamImportHeapMb(maxUpstreamDatabaseBytes),
        ),
        runner: options.upstreamImport?.runner,
    });
    // Reads one copy of the store and writes nothing live, so it takes no import slot.
    registerUpstreamExportRoutes(app, {
        savePath,
        store: resources,
        snapshots,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        staging: upstreamExportStaging,
    });
    // One module, CharX, or Realm import at a time: each holds a spooled file and a write loop. A
    // staged Realm import waiting for its commit is in `realmStaging`, not in the slot.
    const importSlot = createImportSlot();
    registerModuleImportRoutes(app, {
        savePath,
        snapshots,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maxImportBytes,
        diagnostics,
        slot: importSlot,
    });
    registerCharxImportRoutes(app, {
        savePath,
        snapshots,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maxImportBytes,
        diagnostics,
        slot: importSlot,
    });
    registerRealmImportRoutes(app, {
        savePath,
        snapshots,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
        maxImportBytes,
        diagnostics,
        slot: importSlot,
        staging: realmStaging,
        realmOrigin: options.realm?.downloadOrigin,
    });

    diagnostics.record({ kind: "lifecycle", phase: "boot" });
    diagnostics.writeState();

    return {
        app,
        snapshots,
        scriptWorkers,
        beginShutdown,
        generationJobs,
        llmRequests,
        requestHistory,
        translationRunner,
        push,
        eventSockets,
        diagnostics,
        realmStaging,
        upstreamStaging,
        upstreamExportStaging,
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
            diagnostics.start();
        },
        /**
         * Begins shutdown (every generation job is aborted), waits for the jobs to end (bounded by
         * their abort deadline), disposes the script workers, waits for admitted resource handlers
         * and backup operations, then closes the store. The diagnostics' timers stop and its final
         * `state.json` is written once the jobs and the admitted operations ended, while the stores it
         * reads are open; a failure is a `runtime` event and another state. The HTTP entrypoint drains connections before
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
                // Admitted resource handlers and backup operations end here (a restore or an import
                // too), while every store is open: the diagnostics' final state follows them.
                .then(() => snapshots.stop())
                .then(() => realmStaging.close())
                .then(() => upstreamStaging.close())
                .then(() => upstreamExportStaging.close())
                .then(() => {
                    diagnostics.close();
                    diagnostics.writeState();
                })
                .then(() => tokenizers.dispose())
                .then(() => scriptWorkers.dispose())
                .then(() => transformers.dispose())
                .then(() => mcpRegistry.dispose())
                .then(() => vectorCache.close())
                .then(() => requestHistory.close())
                .then(() => resources.close())
                .catch((error: unknown) => {
                    diagnostics.close();
                    diagnostics.record({ kind: "runtime", origin: "dispose", ...errorFields(error) });
                    diagnostics.writeState();
                    throw error;
                });
            return disposing;
        },
    };
}

/** A positive safe integer from the environment variable `name`, else `fallback` when unset or empty. */
function parsePositiveInteger(name: string, raw: string | undefined, fallback: number): number {
    if (raw === undefined || raw === "") {
        return fallback;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name}: ${raw}`);
    }
    return value;
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

/** `version.json`'s version, read once per context (`state.json`); null when it is missing. */
function readAppVersion(rootDir: string): string | null {
    try {
        const parsed = JSON.parse(readFileSync(path.join(rootDir, "version.json"), "utf8")) as { version?: unknown };
        return typeof parsed.version === "string" ? parsed.version : null;
    } catch {
        return null;
    }
}

function parseDiagnosticsMaxBytes(raw: string | undefined): number {
    if (raw === undefined || raw === "") {
        return DIAGNOSTICS_MAX_BYTES;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid RISU_DIAGNOSTICS_MAX_BYTES: ${raw}`);
    }
    return value;
}

function parseRequestHistoryMaxBytes(raw: string | undefined): number {
    if (raw === undefined || raw === "") {
        return REQUEST_HISTORY_MAX_BYTES;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`Invalid RISU_REQUEST_HISTORY_MAX_BYTES: ${raw}`);
    }
    return value;
}
