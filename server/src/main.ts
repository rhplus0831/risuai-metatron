import fs from "node:fs/promises";
import type http from "node:http";
import https from "node:https";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createServerContext } from "./app.ts";

const rootDir = process.cwd();
const SHUTDOWN_GRACE_MS = 8_000;
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
    const context = createServerContext({ rootDir, trustProxy: process.env.TRUST_PROXY });
    const port = Number(process.env.PORT || 6001);
    const httpsOptions = await getHttpsOptions();
    const protocol = httpsOptions ? "https" : "http";

    const server = serve(
        {
            fetch: context.app.fetch,
            port,
            ...(httpsOptions ? { createServer: https.createServer, serverOptions: httpsOptions } : {}),
        },
        (info) => {
            console.log(`[Server] ${protocol.toUpperCase()} server is running.`);
            console.log(`[Server] ${protocol}://localhost:${info.port}/`);
        },
    ) as http.Server;
    server.on("error", (error) => {
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
