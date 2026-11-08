import fs from "node:fs/promises";
import type http from "node:http";
import https from "node:https";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createServerContext } from "./app.ts";
import { errorFields } from "./diagnostics/log.ts";
import { readListenConfig } from "./listenConfig.ts";

/**
 * The process entry (`pnpm run server`): the working directory is the root (`dist/`, `save/`,
 * `server/ssl/`). It listens with HTTPS when both `server/ssl/certificate/server.key` and
 * `server.crt` can be read, else with HTTP (the read error is logged, never fatal), and hands
 * `TRUST_PROXY` to `createServerContext` (`server/src/http/clientIp.ts` parses it). WebSocket
 * upgrades and the background tasks (`attachWebSocket`, `startBackgroundTasks` in
 * `server/src/app.ts`) start only after `serve()` is set up, and SIGINT or SIGTERM runs the
 * shutdown below once. Request receipt is bounded at four hours so large imports can arrive.
 * Shutdown begins context refusal/aborts before closing the listener, allows eight seconds for
 * HTTP draining, destroys remaining connections, then waits for context disposal before exit.
 * Fatal runtime errors are recorded through uncaughtExceptionMonitor without changing Node's
 * exit behavior; server errors are recorded before exit, while the startup catch only logs.
 */

const rootDir = process.cwd();
const SHUTDOWN_GRACE_MS = 8_000;
/**
 * Node's limit for receiving a whole request, raised from its default of 300 s: the backup import
 * and the `.risum` module import upload a whole file in one request, which the default fails with 408
 * under about 1.9 MB/s for a 580 MB file. Finite, so a stalled upload cannot hold an import slot
 * forever; Node's default `headersTimeout` still bounds the headers.
 */
const REQUEST_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const sslPath = path.join(rootDir, "server/ssl/certificate");

async function getHttpsOptions(): Promise<{ key: Buffer; cert: Buffer } | null> {
    const keyPath = path.join(sslPath, "server.key");
    const certPath = path.join(sslPath, "server.crt");
    try {
        const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
        return { key, cert };
    } catch (error) {
        console.error("[Server] SSL setup errors:", (error as Error).message);
        console.log("[Server] Start the server with HTTP instead of HTTPS...");
        return null;
    }
}

async function startServer() {
    const listen = readListenConfig(process.env, rootDir);
    const context = createServerContext({
        rootDir,
        savePath: listen.savePath,
        authBypass: listen.authBypass,
        trustProxy: process.env.TRUST_PROXY,
    });
    // A fault that ends the process lands in the diagnostics folder first: what the journal still
    // has queued, its event, and the state, all written synchronously (`recordFatal`), since no other
    // `uncaughtException` listener exists and the process ends right after the monitor. A monitor
    // leaves Node's behavior as it is: with no `unhandledRejection` listener in this process, an
    // unhandled rejection reaches it too (origin `unhandledRejection`) before the process exits. A
    // failure `startServer`'s own catch takes (here, or in `serve()`'s setup) is not recorded.
    process.on("uncaughtExceptionMonitor", (error, origin) => {
        try {
            context.diagnostics.recordFatal({ kind: "runtime", origin, ...errorFields(error) });
        } catch {}
    });
    const port = listen.port;
    const httpsOptions = await getHttpsOptions();
    const protocol = httpsOptions ? "https" : "http";

    const serverOptions = { requestTimeout: REQUEST_TIMEOUT_MS };
    const server = serve(
        {
            fetch: context.app.fetch,
            port,
            hostname: listen.hostname,
            ...(httpsOptions
                ? { createServer: https.createServer, serverOptions: { ...httpsOptions, ...serverOptions } }
                : { serverOptions }),
        },
        (info) => {
            console.log(`[Server] ${protocol.toUpperCase()} server is running.`);
            const host = listen.hostname ?? "localhost";
            console.log(`[Server] ${protocol}://${host.includes(":") ? `[${host}]` : host}:${info.port}/`);
            if (listen.savePath !== path.join(rootDir, "save")) {
                console.log(`[Server] Storage: ${listen.savePath}`);
            }
            if (listen.authBypass) {
                console.log("[Server] RISU_AGENT_DEV_AUTH_BYPASS: protected routes need no login.");
            }
        },
    ) as http.Server;
    server.on("error", (error) => {
        try {
            context.diagnostics.recordFatal({ kind: "runtime", origin: "serverError", ...errorFields(error) });
        } catch {}
        console.error("[Server] Failed to start server :", error);
        process.exit(1);
    });
    context.attachWebSocket(server);
    context.startBackgroundTasks();

    // Refuse new resource/backup admissions and close keep-alive responses before draining HTTP.
    // Admitted handlers keep the store open through body reads, auth, and their responses. After
    // at most eight seconds (leaving cleanup time within Docker's default ten-second stop timeout),
    // destroy remaining connections, await operation cleanup, and only then close the database.
    let shuttingDown = false;
    const shutdown = (signal: string) => {
        if (shuttingDown) {
            return;
        }
        shuttingDown = true;
        console.log(`[Server] ${signal} received, shutting down...`);
        context.beginShutdown();
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        const deadline = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
        Promise.race([closed, deadline])
            .then(() => {
                server.closeAllConnections?.();
                return context.dispose();
            })
            .then(
                () => process.exit(0),
                (error) => {
                    console.error("[Server] Shutdown failed:", error);
                    process.exit(1);
                },
            );
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

startServer().catch((error) => {
    console.error("[Server] Failed to start server :", error);
    process.exit(1);
});
