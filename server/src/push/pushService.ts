import { createECDH, ECDH } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import webPush from "web-push";
import type { CompletionNotification } from "../../../shared/notifications.ts";
import { mkdirDurableSync, writeFileDurableSync } from "../data/durableWrite.ts";

/** At most this many browsers are subscribed; registering one more drops the least recently registered. */
export const MAX_PUSH_SUBSCRIPTIONS = 50;
/** Completions waiting behind the one being delivered; a completion past this is dropped (a later one of its chat replaces its notice anyway). */
const MAX_PENDING_SENDS = 4;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ENDPOINT_LENGTH = 4096;
const DEFAULT_CONTACT = "mailto:risuai@example.invalid";
const VAPID_FILE = "web_push_vapid.json";
const SUBSCRIPTIONS_FILE = "push_subscriptions.json";

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

export type PushTransport = Pick<typeof webPush, "sendNotification">;

/** A registration's outcome: stored, refused (invalid or outside the allowed hosts), push off, or not saved. */
export type PushRegistration = "ok" | "invalid" | "disabled" | "unsaved";

export type PushService = {
    /** The VAPID public key browsers subscribe with, or null when push is disabled. */
    publicKey(): string | null;
    /** Stores a browser's `PushSubscription.toJSON()`. Nothing changes unless the file was written. */
    register(subscription: unknown): PushRegistration;
    /** `register(...) === "ok"`. */
    upsert(subscription: unknown): boolean;
    /** Removes an endpoint (also in its noncanonical spelling); false only when the file could not be written. */
    remove(endpoint: unknown): boolean;
    /** Sends to every subscription in the background. Never rejects; resolves once delivered or dropped. */
    send(notification: CompletionNotification): Promise<void>;
    /** Shutdown: later sends are dropped. */
    close(): void;
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

function errorCategory(error: unknown): { status: number | null; label: string } {
    const status = isPlainObject(error) && typeof error.statusCode === "number" ? error.statusCode : null;
    return { status, label: status === null ? "network" : `HTTP ${status}` };
}

/**
 * Web Push for chat completions. The subscriptions are per browser, so they are not resources:
 * `save/server/push_subscriptions.json`, beside the password (`routes/auth.ts`), out of the storage
 * routes, backups, and snapshots. Completions are delivered one at a time (each to every subscription
 * in parallel); a subscription the push service reports gone (404, 410) is removed.
 */
export function createPushService(options: {
    savePath: string;
    env?: NodeJS.ProcessEnv;
    /** Tests inject one; the default is `web-push`. */
    transport?: PushTransport;
}): PushService {
    const env = options.env ?? process.env;
    const transport = options.transport ?? webPush;
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
    let closed = false;
    let queue: Promise<void> = Promise.resolve();
    let pending = 0;

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
    function commit(next: StoredSubscription[]): boolean {
        try {
            writeJsonAtomic(subscriptionsFile, { version: 1, subscriptions: next });
        } catch (error) {
            diskUncertain = true;
            console.error("[Push] The subscriptions could not be saved", error);
            return false;
        }
        subscriptions = next;
        diskUncertain = false;
        return true;
    }

    /** Delivery bookkeeping (failure counts, a 404/410 removal): best effort, kept in memory either way. */
    function save() {
        if (unreadable) {
            return;
        }
        const next = list();
        if (!commit(next)) {
            subscriptions = next;
            diskUncertain = true;
        }
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

    async function deliver(notification: CompletionNotification) {
        if (!keys) {
            return;
        }
        const payload = JSON.stringify(notification);
        const vapidDetails = { subject: contact, publicKey: keys.publicKey, privateKey: keys.privateKey };
        // A file that could not be read is tried again, so it delivers once it can be read without
        // waiting for a registration or removal to retry it.
        if (unreadable) {
            known();
        }
        const targets = list().map((entry) => ({ ...entry, keys: { ...entry.keys } }));
        let changed = false;
        await Promise.all(
            targets.map(async (target) => {
                try {
                    await transport.sendNotification(
                        { endpoint: target.endpoint, keys: target.keys, expirationTime: target.expirationTime },
                        payload,
                        {
                            TTL: 60 * 60,
                            urgency: "normal",
                            topic: "chat-completion",
                            timeout: SEND_TIMEOUT_MS,
                            vapidDetails,
                        },
                    );
                    const entry = current(target);
                    if (entry && (entry.failureCount !== 0 || entry.lastError !== undefined)) {
                        entry.failureCount = 0;
                        delete entry.lastError;
                        changed = true;
                    }
                } catch (error) {
                    const { status, label } = errorCategory(error);
                    const entry = current(target);
                    if (!entry) {
                        return;
                    }
                    changed = true;
                    // Memory runs ahead of the file until the bookkeeping write below lands.
                    diskUncertain = true;
                    if (status === 404 || status === 410) {
                        subscriptions = list().filter((other) => other !== entry);
                        return;
                    }
                    entry.failureCount += 1;
                    entry.lastError = label;
                    console.warn(`[Push] A delivery failed (${label})`);
                }
            }),
        );
        if (changed) {
            save();
        }
    }

    function register(raw: unknown): PushRegistration {
        if (!keys) {
            return "disabled";
        }
        const parsed = parseSubscription(raw, hosts);
        if (!parsed) {
            return "invalid";
        }
        if (!known()) {
            return "unsaved";
        }
        const others = list().filter((entry) => entry.endpoint !== parsed.endpoint);
        const next = [{ ...parsed, failureCount: 0, updatedAt: Date.now() }, ...others].slice(
            0,
            MAX_PUSH_SUBSCRIPTIONS,
        );
        return commit(next) ? "ok" : "unsaved";
    }

    return {
        publicKey: () => keys?.publicKey ?? null,
        register,
        upsert: (raw) => register(raw) === "ok",
        remove(endpoint) {
            const href = canonicalEndpoint(endpoint);
            if (href === null) {
                return true;
            }
            if (!known()) {
                return false;
            }
            const before = list();
            const after = before.filter((entry) => entry.endpoint !== href);
            return (after.length === before.length && !diskUncertain) || commit(after);
        },
        send(notification) {
            if (closed || !keys || pending >= MAX_PENDING_SENDS) {
                return Promise.resolve();
            }
            pending += 1;
            const run = queue
                .then(() => (closed ? undefined : deliver(notification)))
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
    };
}
