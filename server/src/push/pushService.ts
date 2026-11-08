import { createECDH, ECDH } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import webPush from "web-push";
import type { PUSH_DROP_REASONS, PUSH_SERVICES } from "../../../shared/diagnostics.ts";
import {
    COMPLETION_NOTIFICATION_TAG,
    PUSH_REGISTRATION_REFRESH_MS,
    type CompletionNotification,
} from "../../../shared/notifications.ts";
import { type DurableFs, mkdirDurableSync, writeFileDurable, writeFileDurableSync } from "../data/durableWrite.ts";
import { createOrderedWriter, type OrderedWriter } from "../data/orderedWriter.ts";
import { type DiagnosticsRecorder, recordSafely } from "../diagnostics/log.ts";

/**
 * Server Web Push delivery for shared/notifications.ts completions, with browser subscriptions in
 * save/server outside resources, archives, and snapshots. VAPID comes from a complete environment
 * pair or a generated/persisted key file; an invalid existing pair/file or contact disables push
 * without replacing the file. Endpoints are canonical HTTPS DNS URLs on allowed push hosts; keys
 * are validated before storage. RISU_WEB_PUSH_ALLOWED_HOSTS extends the built-in exact/suffix list.
 *
 * Subscription changes serialize on one server/src/data/orderedWriter.ts key and publish through
 * server/src/data/durableWrite.ts before installation. Unreadable lists block replacement and are
 * retried; delivery outcomes update bookkeeping in a later best-effort write. Registrations keep
 * at most 50 endpoints and skip recent unchanged healthy entries. Completions queue serially with
 * at most four pending sends, each fan-out parallel, ten-second transport timeouts, one-hour TTL,
 * high urgency, and a per-chat topic when valid. Gone endpoints (404/410) are removed. Diagnostics
 * carry service/outcome/job identifiers, never payloads or endpoints. Shutdown drops later sends;
 * drain waits for queued subscription operations, without waiting for a delivery in flight.
 */

/** At most this many browsers are subscribed; registering one more drops the least recently refreshed. */
export const MAX_PUSH_SUBSCRIPTIONS = 50;
/** Completions waiting behind the one being delivered; a completion past this is dropped (a later one of its chat replaces its notice anyway). */
const MAX_PENDING_SENDS = 4;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ENDPOINT_LENGTH = 4096;
const DEFAULT_CONTACT = "mailto:risuai@example.invalid";
const VAPID_FILE = "web_push_vapid.json";
const SUBSCRIPTIONS_FILE = "push_subscriptions.json";
const SUBSCRIPTIONS_KEY = "push:subscriptions";

/**
 * The push services the server posts to. The server sends a request to whatever endpoint a browser
 * registered, so an endpoint outside these hosts is refused (`RISU_WEB_PUSH_ALLOWED_HOSTS` adds more,
 * comma-separated; a leading `.` allows the subdomains).
 */
const DEFAULT_ALLOWED_HOSTS = [
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "web.push.apple.com",
    ".push.apple.com",
    ".notify.windows.com",
];

type StoredSubscription = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
    expirationTime: number | null;
    failureCount: number;
    /** `HTTP <status>` or `network`: never the endpoint or a response body. */
    lastError?: string;
    updatedAt: number;
};

/** What a settled delivery left for the next operation to apply: `status` is null for no HTTP answer. */
type DeliveryOutcome = { target: StoredSubscription; status: number | null; ok: boolean };

/** The Web Push delivery transport, injectable without changing subscription persistence. */
export type PushTransport = Pick<typeof webPush, "sendNotification">;

/** A registration's outcome: stored, refused (invalid or outside the allowed hosts), push off, or not saved. */
export type PushRegistration = "ok" | "invalid" | "disabled" | "unsaved";

/** Public-key lookup, durable subscription changes, completion delivery, and shutdown controls. */
export type PushService = {
    /** The VAPID public key browsers subscribe with, or null when push is disabled. */
    publicKey(): string | null;
    /** Stores a browser's `PushSubscription.toJSON()`; an unchanged, healthy registration within the refresh interval writes nothing. */
    register(subscription: unknown): Promise<PushRegistration>;
    /** `register(...) === "ok"`. */
    upsert(subscription: unknown): Promise<boolean>;
    /** Removes an endpoint (also in its noncanonical spelling); false only when the file could not be written. */
    remove(endpoint: unknown): Promise<boolean>;
    /**
     * Sends to every subscription in the background. Never rejects; resolves once delivered or dropped.
     * `context.jobId` (the job that completed) goes only into the diagnostic events, never the payload.
     */
    send(notification: CompletionNotification, context?: { jobId?: string }): Promise<void>;
    /** Shutdown: later sends are dropped. */
    close(): void;
    /**
     * Waits for the operations queued on the subscriptions, not for a delivery in flight: a shutdown
     * does not wait out its transport timeout, and a late outcome's write is best effort.
     */
    drain(): Promise<void>;
};

/** A browser's keys may carry `=` padding; `web-push` accepts a VAPID key only without it. */
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;
const BASE64URL_UNPADDED = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(value: unknown, pattern = BASE64URL): Buffer | null {
    if (typeof value !== "string" || value.length === 0 || value.length > 512 || !pattern.test(value)) {
        return null;
    }
    return Buffer.from(value.replace(/=+$/, ""), "base64url");
}

/** An uncompressed P-256 point on the curve (`p256dh`, a VAPID public key). */
function isP256Point(bytes: Buffer | null): bytes is Buffer {
    if (bytes === null || bytes.length !== 65 || bytes[0] !== 0x04) {
        return false;
    }
    try {
        // Refuses a point that is not on the curve.
        ECDH.convertKey(bytes, "prime256v1");
        return true;
    } catch {
        return false;
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function allowedHosts(env: NodeJS.ProcessEnv): string[] {
    const extra = (env.RISU_WEB_PUSH_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
    return [...DEFAULT_ALLOWED_HOSTS, ...extra];
}

/** A DNS name of at least two labels (punycode included), nothing else. */
const DNS_HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** The endpoint as the WHATWG parser writes it, or null for one that is not a URL. */
function canonicalEndpoint(endpoint: unknown): string | null {
    if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
        return null;
    }
    try {
        return new URL(endpoint).href;
    } catch {
        return null;
    }
}

/**
 * The canonical endpoint when it is an allowed push service, else null. Only the canonical `href` is
 * stored and posted to: `web-push` parses with the legacy `url.parse`, which reads a host spelled with
 * escapes (`127.0.0.1%2enotify.windows.com`) differently from the WHATWG parser checked here.
 */
function allowedEndpoint(endpoint: unknown, hosts: readonly string[]): string | null {
    const href = canonicalEndpoint(endpoint);
    if (href === null || href.length > MAX_ENDPOINT_LENGTH) {
        return null;
    }
    const url = new URL(href);
    if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || url.hash) {
        return null;
    }
    const host = url.hostname.toLowerCase();
    // Letters, digits, and hyphens only: any other character a WHATWG host keeps (`'`, `"`, `;`, `{`)
    // ends the host for `url.parse`, which would then post to what comes before it.
    if (!DNS_HOSTNAME.test(host)) {
        return null;
    }
    return hosts.some((allowed) => (allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed)) ? href : null;
}

/** A subscription as stored, from a browser's `toJSON()` or the file; null when any part is invalid. */
function parseSubscription(
    raw: unknown,
    hosts: readonly string[],
): Omit<StoredSubscription, "updatedAt" | "failureCount"> | null {
    const endpoint = isPlainObject(raw) ? allowedEndpoint(raw.endpoint, hosts) : null;
    if (!isPlainObject(raw) || endpoint === null || !isPlainObject(raw.keys)) {
        return null;
    }
    const p256dh = decodeBase64Url(raw.keys.p256dh);
    const auth = decodeBase64Url(raw.keys.auth);
    if (!isP256Point(p256dh) || auth === null || auth.length !== 16) {
        return null;
    }
    const expiration = raw.expirationTime;
    if (
        expiration !== undefined &&
        expiration !== null &&
        !(typeof expiration === "number" && Number.isFinite(expiration))
    ) {
        return null;
    }
    return {
        endpoint,
        // Stored unpadded, so a key is compared and sent in one spelling.
        keys: { p256dh: p256dh.toString("base64url"), auth: auth.toString("base64url") },
        expirationTime: typeof expiration === "number" ? expiration : null,
    };
}

/** Writes `data` as JSON through a flushed temporary file, then renames it and syncs the directory. */
function writeJsonAtomic(file: string, data: unknown) {
    writeFileDurableSync(file, JSON.stringify(data), { mode: 0o600 });
}

type VapidKeys = { publicKey: string; privateKey: string };

/**
 * A pair `web-push` can sign with: both keys unpadded base64url (it refuses padding), the public key a
 * P-256 point, and the public key the one the private key derives (a pair mixed from two keys would be
 * advertised and never deliver).
 */
function isVapidPair(value: unknown): value is VapidKeys {
    if (!isPlainObject(value)) {
        return false;
    }
    const publicKey = decodeBase64Url(value.publicKey, BASE64URL_UNPADDED);
    const privateKey = decodeBase64Url(value.privateKey, BASE64URL_UNPADDED);
    if (!isP256Point(publicKey) || privateKey === null || privateKey.length !== 32) {
        return false;
    }
    try {
        const ecdh = createECDH("prime256v1");
        ecdh.setPrivateKey(privateKey);
        return ecdh.getPublicKey().equals(publicKey);
    } catch {
        return false;
    }
}

/** A VAPID subject `web-push` accepts: a `mailto:` address or an `https:` URL. */
function isVapidSubject(subject: string): boolean {
    try {
        const url = new URL(subject);
        return url.protocol === "mailto:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

/**
 * The VAPID key pair: both `RISU_WEB_PUSH_VAPID_PUBLIC_KEY` and `RISU_WEB_PUSH_VAPID_PRIVATE_KEY`, else
 * `save/server/web_push_vapid.json`, generated on the first start. An invalid pair, one of the two
 * variables alone, or an unreadable key file disables push (an existing file is never replaced: the
 * browsers subscribed with its key).
 */
function loadVapidKeys(serverDir: string, env: NodeJS.ProcessEnv): VapidKeys | null {
    const envPublic = env.RISU_WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
    const envPrivate = env.RISU_WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
    if (envPublic || envPrivate) {
        const pair = { publicKey: envPublic, privateKey: envPrivate };
        if (isVapidPair(pair)) {
            return pair;
        }
        console.error("[Push] The RISU_WEB_PUSH_VAPID_* key pair is incomplete or invalid; push notifications are off");
        return null;
    }
    const file = path.join(serverDir, VAPID_FILE);
    if (existsSync(file)) {
        try {
            const stored: unknown = JSON.parse(readFileSync(file, "utf-8"));
            if (isVapidPair(stored)) {
                return { publicKey: stored.publicKey, privateKey: stored.privateKey };
            }
        } catch {}
        console.error(`[Push] ${VAPID_FILE} is unreadable or invalid; push notifications are off`);
        return null;
    }
    const generated = webPush.generateVAPIDKeys();
    writeJsonAtomic(file, generated);
    return generated;
}

const failureLabel = (status: number | null) => (status === null ? "network" : `HTTP ${status}`);

function errorStatus(error: unknown): number | null {
    return isPlainObject(error) && typeof error.statusCode === "number" ? error.statusCode : null;
}

/** The push service of a stored endpoint, from its host, as a diagnostic event names it (never the endpoint). */
function pushServiceOf(endpoint: string): (typeof PUSH_SERVICES)[number] {
    let host: string;
    try {
        host = new URL(endpoint).hostname.toLowerCase();
    } catch {
        return "other";
    }
    if (host === "fcm.googleapis.com" || host === "android.googleapis.com") {
        return "fcm";
    }
    if (host === "push.apple.com" || host.endsWith(".push.apple.com")) {
        return "apple";
    }
    if (host === "mozilla.com" || host.endsWith(".mozilla.com")) {
        return "mozilla";
    }
    if (host.endsWith(".notify.windows.com")) {
        return "windows";
    }
    return "other";
}

/** RFC 8030 `Topic`: at most 32 characters of the URL-safe base64 alphabet. */
const PUSH_TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The push topic of a completion: its chat's tag hash (`completionNotificationTag`), so a push service
 * that still holds one chat's undelivered completion replaces it only with a later one of the same chat.
 * A tag without a valid hash (the bare prefix) gets no topic: `web-push` refuses an invalid one, and no
 * topic means nothing is replaced.
 */
function completionTopic(tag: string): string | undefined {
    const prefix = `${COMPLETION_NOTIFICATION_TAG}:`;
    const hash = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
    return PUSH_TOPIC.test(hash) ? hash : undefined;
}

/**
 * Web Push for chat completions. The subscriptions are per browser, so they are not resources:
 * `save/server/push_subscriptions.json`, beside the password (`routes/auth.ts`), out of the storage
 * routes, backups, and snapshots. Completions are delivered one at a time (each to every subscription
 * in parallel); a subscription the push service reports gone (404, 410) is removed.
 *
 * The list changes only inside operations on `writer`, one key: an operation applies what deliveries
 * left, reads the list, derives the next one, writes it durably, and installs it in memory only after
 * the write, so two registrations cannot lose each other. A delivery only leaves its outcomes; one
 * operation per settled batch applies and writes them, and nothing waits for that write.
 *
 * Each completion leaves content-free `push` events in `diagnostics`: one per subscription it was sent
 * to (`accepted`, `failed`, `removed`, with the push service and the job), or one `dropped` with the
 * reason nothing was sent. A recorder that throws never changes delivery.
 */
export function createPushService(options: {
    savePath: string;
    env?: NodeJS.ProcessEnv;
    /** Tests inject one; the default is `web-push`. */
    transport?: PushTransport;
    /** The diagnostics journal. */
    diagnostics?: DiagnosticsRecorder;
    now?: () => number;
    /** The server context's writer; default one of its own. */
    writer?: OrderedWriter;
    /** What the subscription writes call (tests inject latency and failures); default `node:fs/promises`. */
    fs?: DurableFs;
}): PushService {
    const env = options.env ?? process.env;
    const writer = options.writer ?? createOrderedWriter();
    const transport = options.transport ?? webPush;
    const now = options.now ?? Date.now;
    const serverDir = path.join(options.savePath, "server");
    mkdirDurableSync(serverDir);
    const subscriptionsFile = path.join(serverDir, SUBSCRIPTIONS_FILE);
    const hosts = allowedHosts(env);
    let keys: VapidKeys | null;
    try {
        keys = loadVapidKeys(serverDir, env);
    } catch (error) {
        console.error("[Push] The VAPID keys could not be created; push notifications are off", error);
        keys = null;
    }
    const contact = env.RISU_WEB_PUSH_CONTACT?.trim() || DEFAULT_CONTACT;
    if (keys && !isVapidSubject(contact)) {
        console.error("[Push] RISU_WEB_PUSH_CONTACT must be a mailto: or https: URL; push notifications are off");
        keys = null;
    }

    let subscriptions: StoredSubscription[] | null = null;
    /**
     * The file may hold what memory does not: invalid JSON, a failed bookkeeping write, or a commit
     * whose rename landed before its directory sync failed. A removal then writes even when memory
     * lacks the endpoint.
     */
    let diskUncertain = false;
    /** The file exists but could not be read: its contents are unknown, so nothing replaces it. */
    let unreadable = false;
    /** The settled transport outcomes no operation has applied yet. */
    const pendingOutcomes: DeliveryOutcome[] = [];
    /** Memory holds applied outcomes the file does not. */
    let dirty = false;
    /** A bookkeeping operation is queued and not yet started. */
    let bookkeepingQueued = false;
    let closed = false;
    let queue: Promise<void> = Promise.resolve();
    let pending = 0;

    function dropped(reason: (typeof PUSH_DROP_REASONS)[number], jobId: string | undefined) {
        recordSafely(options.diagnostics, { kind: "push", phase: "dropped", reason, jobId });
    }

    /** The stored subscriptions, read once; invalid entries (a host no longer allowed) are left out. */
    function list(): StoredSubscription[] {
        if (subscriptions) {
            return subscriptions;
        }
        subscriptions = [];
        if (!existsSync(subscriptionsFile)) {
            return subscriptions;
        }
        let text: string;
        try {
            text = readFileSync(subscriptionsFile, "utf-8");
        } catch {
            console.error(`[Push] ${SUBSCRIPTIONS_FILE} could not be read; registrations wait until it can`);
            unreadable = true;
            return subscriptions;
        }
        try {
            const stored: unknown = JSON.parse(text);
            const rows = isPlainObject(stored) && Array.isArray(stored.subscriptions) ? stored.subscriptions : [];
            for (const row of rows) {
                const parsed = parseSubscription(row, hosts);
                if (parsed && !subscriptions.some((entry) => entry.endpoint === parsed.endpoint)) {
                    subscriptions.push({
                        ...parsed,
                        failureCount:
                            isPlainObject(row) && Number.isInteger(row.failureCount) ? (row.failureCount as number) : 0,
                        ...(isPlainObject(row) && typeof row.lastError === "string"
                            ? { lastError: row.lastError }
                            : {}),
                        updatedAt: isPlainObject(row) && Number.isFinite(row.updatedAt) ? (row.updatedAt as number) : 0,
                    });
                }
            }
            subscriptions = subscriptions.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_PUSH_SUBSCRIPTIONS);
        } catch {
            // Readable but not JSON: nothing in it can be used, so the next write replaces it.
            console.error(`[Push] ${SUBSCRIPTIONS_FILE} is not valid JSON; starting without subscriptions`);
            diskUncertain = true;
        }
        return subscriptions;
    }

    /** Whether the stored list is known; a file that could not be read is tried again first. */
    function known(): boolean {
        if (unreadable) {
            unreadable = false;
            subscriptions = null;
        }
        list();
        return !unreadable;
    }

    /** Writes `next` and only then makes it the list; false (the list unchanged) when the write failed. */
    async function commit(next: StoredSubscription[]): Promise<boolean> {
        try {
            await writeFileDurable(subscriptionsFile, JSON.stringify({ version: 1, subscriptions: next }), {
                mode: 0o600,
                fs: options.fs,
            });
        } catch (error) {
            diskUncertain = true;
            console.error("[Push] The subscriptions could not be saved", error);
            return false;
        }
        subscriptions = next;
        diskUncertain = false;
        dirty = false;
        return true;
    }

    /** The stored entry `sent` was, if it is still stored with the same keys (not removed or registered again). */
    function current(sent: StoredSubscription): StoredSubscription | undefined {
        return list().find(
            (entry) =>
                entry.endpoint === sent.endpoint &&
                entry.keys.p256dh === sent.keys.p256dh &&
                entry.keys.auth === sent.keys.auth,
        );
    }

    /** Moves the settled outcomes into memory. Runs first in every operation, so it sees all of them. */
    function applyOutcomes() {
        for (const { target, status, ok } of pendingOutcomes.splice(0)) {
            const entry = current(target);
            if (ok) {
                if (entry && (entry.failureCount !== 0 || entry.lastError !== undefined)) {
                    entry.failureCount = 0;
                    delete entry.lastError;
                    dirty = true;
                }
                continue;
            }
            if (!entry) {
                continue;
            }
            dirty = true;
            // Memory runs ahead of the file until a write lands.
            diskUncertain = true;
            if (status === 404 || status === 410) {
                subscriptions = list().filter((other) => other !== entry);
                continue;
            }
            entry.failureCount += 1;
            entry.lastError = failureLabel(status);
        }
    }

    /**
     * Delivery bookkeeping (failure counts, a 404/410 removal): one operation after a settled batch,
     * awaited by no one. Best effort: a failed write keeps memory and leaves the file uncertain.
     */
    function scheduleBookkeeping() {
        if (bookkeepingQueued) {
            return;
        }
        bookkeepingQueued = true;
        writer
            .run(SUBSCRIPTIONS_KEY, async () => {
                bookkeepingQueued = false;
                applyOutcomes();
                if (dirty && !unreadable) {
                    await commit(list());
                }
            })
            .catch((error) => console.error("[Push] The subscriptions could not be saved", error));
    }

    async function deliver(notification: CompletionNotification, jobId: string | undefined) {
        if (!keys) {
            dropped("noKeys", jobId);
            return;
        }
        const payload = JSON.stringify(notification);
        const topic = completionTopic(notification.tag);
        const vapidDetails = { subject: contact, publicKey: keys.publicKey, privateKey: keys.privateKey };
        // A file that could not be read is tried again, so it delivers once it can be read without
        // waiting for a registration or removal to retry it.
        if (unreadable) {
            known();
        }
        const targets = list().map((entry) => ({ ...entry, keys: { ...entry.keys } }));
        if (targets.length === 0) {
            dropped(unreadable ? "unreadable" : "noSubscriptions", jobId);
            return;
        }
        await Promise.all(
            targets.map(async (target) => {
                const service = pushServiceOf(target.endpoint);
                try {
                    await transport.sendNotification(
                        { endpoint: target.endpoint, keys: target.keys, expirationTime: target.expirationTime },
                        payload,
                        {
                            TTL: 60 * 60,
                            urgency: "high",
                            ...(topic ? { topic } : {}),
                            timeout: SEND_TIMEOUT_MS,
                            vapidDetails,
                        },
                    );
                    // The transport's outcome is recorded even when the subscription was removed or
                    // registered again meanwhile.
                    recordSafely(options.diagnostics, { kind: "push", phase: "accepted", service, jobId });
                    pendingOutcomes.push({ target, status: null, ok: true });
                } catch (error) {
                    const status = errorStatus(error);
                    recordSafely(
                        options.diagnostics,
                        status === 404 || status === 410
                            ? { kind: "push", phase: "removed", service, jobId }
                            : { kind: "push", phase: "failed", service, jobId, status },
                    );
                    pendingOutcomes.push({ target, status, ok: false });
                    if (status !== 404 && status !== 410 && current(target)) {
                        console.warn(`[Push] A delivery failed (${failureLabel(status)})`);
                    }
                }
            }),
        );
        scheduleBookkeeping();
    }

    async function register(raw: unknown): Promise<PushRegistration> {
        if (!keys) {
            return "disabled";
        }
        const parsed = parseSubscription(raw, hosts);
        if (!parsed) {
            return "invalid";
        }
        return await writer.run(SUBSCRIPTIONS_KEY, async () => {
            applyOutcomes();
            if (!known()) {
                return "unsaved";
            }
            const at = now();
            const existing = list().find((entry) => entry.endpoint === parsed.endpoint);
            if (
                existing &&
                existing.keys.p256dh === parsed.keys.p256dh &&
                existing.keys.auth === parsed.keys.auth &&
                existing.expirationTime === parsed.expirationTime &&
                existing.failureCount === 0 &&
                existing.lastError === undefined &&
                at - existing.updatedAt >= 0 &&
                at - existing.updatedAt < PUSH_REGISTRATION_REFRESH_MS &&
                !diskUncertain
            ) {
                return "ok";
            }
            const others = list().filter((entry) => entry.endpoint !== parsed.endpoint);
            const next = [{ ...parsed, failureCount: 0, updatedAt: at }, ...others].slice(0, MAX_PUSH_SUBSCRIPTIONS);
            return (await commit(next)) ? "ok" : "unsaved";
        });
    }

    return {
        publicKey: () => keys?.publicKey ?? null,
        register,
        upsert: async (raw) => (await register(raw)) === "ok",
        async remove(endpoint) {
            const href = canonicalEndpoint(endpoint);
            if (href === null) {
                return true;
            }
            return await writer.run(SUBSCRIPTIONS_KEY, async () => {
                applyOutcomes();
                if (!known()) {
                    return false;
                }
                const before = list();
                const after = before.filter((entry) => entry.endpoint !== href);
                return (after.length === before.length && !diskUncertain) || (await commit(after));
            });
        },
        send(notification, context) {
            const jobId = context?.jobId;
            if (closed || !keys || pending >= MAX_PENDING_SENDS) {
                dropped(closed ? "closed" : !keys ? "noKeys" : "queueFull", jobId);
                return Promise.resolve();
            }
            pending += 1;
            const run = queue
                .then(() => (closed ? dropped("closed", jobId) : deliver(notification, jobId)))
                .catch((error) => console.error("[Push] Sending failed", error))
                .finally(() => {
                    pending -= 1;
                });
            queue = run;
            return run;
        },
        close() {
            closed = true;
        },
        drain: () => writer.settled(SUBSCRIPTIONS_KEY),
    };
}
