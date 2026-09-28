import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS, type ResourceKind } from "./data/kinds.ts";
import { createResourceStore } from "./data/resourceStore.ts";
import { compileTrust, getClientIp, parseTrustProxyEnv } from "./http/clientIp.ts";
import { createRateLimiter } from "./http/rateLimit.ts";
import { createAuthStore } from "./routes/auth.ts";
import { registerProxyRoutes } from "./routes/proxy.ts";
import { createProxyStreamJobs } from "./routes/proxyStreamJobs.ts";
import { registerResourceRoutes } from "./routes/resources.ts";
import { registerStorageRoutes } from "./routes/storage.ts";
import type { AppEnv } from "./types.ts";

const MAX_BODY_BYTES = 100 * 1024 * 1024;
const headOpenTag = /<head(\s[^>]*)?>/i;

export type ServerContext = ReturnType<typeof createServerContext>;

/**
 * Builds the self-host server: `rootDir/dist` is the built client, `rootDir/save` the storage.
 * All state (password, known keys, stream jobs, rate-limit counters, the resource database) lives in
 * the returned context. `resourceKinds` replaces the default resource kinds (tests use it).
 */
export function createServerContext(options: {
    rootDir: string;
    trustProxy?: string;
    resourceKinds?: readonly ResourceKind[];
}) {
    const savePath = path.join(options.rootDir, "save");
    const distPath = path.join(options.rootDir, "dist");
    mkdirSync(savePath, { recursive: true });

    const trust = compileTrust(parseTrustProxyEnv(options.trustProxy));
    const clientIp = (c: Parameters<typeof getClientIp>[0]) => getClientIp(c, trust);

    const auth = createAuthStore(savePath);
    const resourceKinds = createKindRegistry(options.resourceKinds ?? DEFAULT_RESOURCE_KINDS);
    // `save/data/` is not a storage namespace, so the `/api/*` storage routes cannot reach the file.
    const resources = createResourceStore({
        file: path.join(savePath, "data", "resources.sqlite"),
        kinds: resourceKinds,
    });
    const proxyStreamJobs = createProxyStreamJobs({ auth });

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

    app.onError((error, c) => {
        if (error instanceof HTTPException) {
            return error.getResponse();
        }
        console.error(error);
        return c.text("Internal Server Error", 500);
    });

    app.use(
        bodyLimit({
            maxSize: MAX_BODY_BYTES,
            onError: (c) => c.json({ error: "Request body too large" }, 413),
        }),
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
    auth.registerRoutes(app, { auth: authRouteLimiter.middleware, login: loginRouteLimiter.middleware });
    registerStorageRoutes(app, { savePath, auth, limiter: authenticatedRouteLimiter.middleware });
    registerResourceRoutes(app, {
        store: resources,
        kinds: resourceKinds,
        auth,
        limiter: authenticatedRouteLimiter.middleware,
    });

    return {
        app,
        attachWebSocket: (server: http.Server) => proxyStreamJobs.attachWebSocket(server),
        startBackgroundTasks: () => proxyStreamJobs.startGc(),
        dispose: () => {
            proxyStreamJobs.dispose();
            authenticatedRouteLimiter.dispose();
            authRouteLimiter.dispose();
            loginRouteLimiter.dispose();
            resources.close();
        },
    };
}
