import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { EVENT_FEED_PATH, type EventFeedFrame } from "../../../shared/events.ts";
import type { ChangeFeed, ChangeFeedEvent } from "../data/changeFeed.ts";

const HEARTBEAT_MS = 15_000;
/** A socket that falls this far behind is closed; its client reconnects and reconciles. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export type EventSockets = ReturnType<typeof createEventSockets>;

/**
 * The live-update socket (`/api/events/ws`, Phase 6): every committed change the resource store
 * publishes goes to every connected client as refs and revisions (`shared/events.ts`). The handshake
 * needs a JWT (`risu-auth` query or header), never the raw password. On connect the socket sends
 * `hello` with the epoch; nothing is replayed, so a client reconciles from the revision listing
 * after every `hello`. Sockets are not tracked by the snapshot manager and not gated by maintenance:
 * a restore publishes `epoch`, which reloads the clients.
 */
export function createEventSockets(options: {
    feed: ChangeFeed;
    epoch: () => string;
    authorize: (token: string | undefined) => Promise<boolean>;
}) {
    const { feed, epoch, authorize } = options;
    const wsServer = new WebSocketServer({ noServer: true });
    const sockets = new Set<WebSocket>();
    let closed = false;

    function send(ws: WebSocket, frame: EventFeedFrame) {
        if (ws.readyState !== ws.OPEN) {
            return;
        }
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            ws.terminate();
            return;
        }
        ws.send(JSON.stringify(frame));
    }

    const unsubscribe = feed.subscribe((event: ChangeFeedEvent) => {
        const frame: EventFeedFrame =
            event.type === "change"
                ? { type: "change", epoch: event.epoch, changes: event.changes }
                : { type: "epoch", epoch: event.epoch };
        for (const ws of sockets) {
            send(ws, frame);
        }
    });

    function attach(ws: WebSocket) {
        sockets.add(ws);
        send(ws, { type: "hello", epoch: epoch() });
        const ping = setInterval(() => send(ws, { type: "ping", ts: Date.now() }), HEARTBEAT_MS);
        const drop = () => {
            clearInterval(ping);
            sockets.delete(ws);
        };
        ws.on("close", drop);
        ws.on("error", drop);
        // The socket is server to client only.
        ws.on("message", () => {});
    }

    /** The `upgrade` handler for `/api/events/ws`; false, leaving the socket untouched, for any other path. */
    function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): boolean {
        let url: URL;
        try {
            url = new URL(req.url ?? "", "http://localhost");
        } catch {
            return false;
        }
        if (url.pathname !== EVENT_FEED_PATH) {
            return false;
        }
        void (async () => {
            try {
                const headerAuth = req.headers["risu-auth"];
                const token =
                    url.searchParams.get("risu-auth") || (Array.isArray(headerAuth) ? headerAuth[0] : headerAuth);
                if (!(await authorize(token))) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                    socket.destroy();
                    return;
                }
                if (closed || socket.destroyed) {
                    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
                    socket.destroy();
                    return;
                }
                wsServer.handleUpgrade(req, socket, head, (ws) => {
                    if (closed) {
                        ws.close(1001);
                        return;
                    }
                    attach(ws);
                });
            } catch {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
            }
        })();
        return true;
    }

    return {
        handleUpgrade,

        /** How many clients are connected (tests). */
        size(): number {
            return sockets.size;
        },

        /** Closes every socket with 1001 (going away) and refuses new ones. */
        close() {
            if (closed) {
                return;
            }
            closed = true;
            unsubscribe();
            for (const ws of sockets) {
                ws.close(1001);
            }
            sockets.clear();
            wsServer.close();
        },
    };
}
