// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import webPush from "web-push";
import { Hono } from "hono";
import { createAuthStore } from "../routes/auth.ts";
import { registerPushRoutes } from "../routes/push.ts";
import type { AppEnv } from "../types.ts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DiagnosticEventInput } from "../../../shared/diagnostics.ts";
import {
    COMPLETION_NOTIFICATION_TAG,
    completionNotificationTag,
    PUSH_REGISTRATION_REFRESH_MS,
    type CompletionNotification,
} from "../../../shared/notifications.ts";
import type { DurableFs } from "../data/durableWrite.ts";
import { createPushService, MAX_PUSH_SUBSCRIPTIONS, type PushTransport } from "../push/pushService.ts";
import { createSigner, createTestServer, json } from "./testSupport.ts";

// The push service (`server/src/push/pushService.ts`) over a temporary `save/` with an injected
// transport, and its routes (`server/src/routes/push.ts`) on the real app. The VAPID pair (generated
// once into `save/server/web_push_vapid.json`, mode 0600, kept across restarts; the environment
// pair; one variable alone, an invalid pair, or an unreadable file turning push off without
// replacing the file), the subscription validation (the allowed push hosts, `https` only, no port,
// credentials, or fragment, the P-256 point, the 16-byte auth secret, `expirationTime`), the file
// (invalid rows dropped on load, the cap of 50 keeping the newest, the atomic write), delivery
// (every subscription in parallel with the payload and the per-call VAPID details, 404/410 removing
// the subscription, other failures counted with a sanitized label, a success clearing them, written
// by a queued bookkeeping operation that `drain` waits for, the sends one at a time with a bounded
// queue, `close`, never a rejection), and the routes
// (authenticated before the body, `no-store`, 400/503, the 16 KiB cap that the global limiter leaves
// to the route, DELETE idempotent), and the content-free `push` diagnostic events (one per
// subscription's transport outcome, named by its push service and the job, or one `dropped` with its
// reason; a throwing recorder changes nothing). The `it.fails` cases pin intended behavior the
// implementation does not meet yet: they turn green once fixed.

const ALLOWED = "https://fcm.googleapis.com/fcm/send/";
let counter = 0;

/** A browser's `PushSubscription.toJSON()`: a fresh P-256 point and a 16-byte secret. */
function subscription(endpoint = `${ALLOWED}sub-${++counter}`, extra: Record<string, unknown> = {}) {
    return {
        endpoint,
        expirationTime: null,
        keys: { p256dh: webPush.generateVAPIDKeys().publicKey, auth: randomBytes(16).toString("base64url") },
        ...extra,
    };
}

const NOTIFICATION: CompletionNotification = {
    title: "Risuai",
    body: "Ann's message has been processed.",
    url: "/chat/c/k",
    tag: "risuai-chat-completion",
    icon: "/logo_192.png",
    badge: "/logo_192.png",
};

type Call = {
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
    payload: string;
    options: any;
};

/** A transport that records every send and answers as `answer` says (a thrown object, else success). */
function fakeTransport(answer: (call: Call) => unknown = () => undefined) {
    const calls: Call[] = [];
    const transport: PushTransport = {
        sendNotification: vi.fn(async (sub: any, payload: any, options: any) => {
            const call = { subscription: sub, payload: String(payload), options };
            calls.push(call);
            const failure = answer(call);
            if (failure !== undefined) {
                throw failure;
            }
            return { statusCode: 201, body: "", headers: {} };
        }) as unknown as PushTransport["sendNotification"],
    };
    return { calls, transport };
}

const httpError = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });

let dirs: string[] = [];
function savePath() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "risu-push-"));
    dirs.push(dir);
    return path.join(dir, "save");
}
const serverFile = (save: string, name: string) => path.join(save, "server", name);
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
/** A service's `fs` option over the real files, with its writes counted: each one ends in one rename. */
function countedFs() {
    const rename = vi.fn(promises.rename);
    const fs: DurableFs = { ...promises, rename };
    return { fs, rename };
}
/** One turn of the event loop: a delivery that can run (nothing but microtasks in these tests) has run. */
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterAll(() => {
    vi.restoreAllMocks();
});
afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("the VAPID keys", () => {
    it("are generated once into save/server/web_push_vapid.json (owner-only) and kept across restarts", () => {
        const save = savePath();
        const first = createPushService({ savePath: save, env: {}, transport: fakeTransport().transport });
        const file = serverFile(save, "web_push_vapid.json");
        const stored = readJson(file);
        expect(first.publicKey()).toBe(stored.publicKey);
        expect(Buffer.from(stored.publicKey, "base64url")).toHaveLength(65);
        expect(Buffer.from(stored.privateKey, "base64url")).toHaveLength(32);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        // The pair is what `web-push` accepts (URL-safe base64 without padding).
        expect(() =>
            webPush.getVapidHeaders(
                "https://fcm.googleapis.com",
                "mailto:a@b.c",
                stored.publicKey,
                stored.privateKey,
                "aes128gcm",
            ),
        ).not.toThrow();

        const second = createPushService({ savePath: save, env: {}, transport: fakeTransport().transport });
        expect(second.publicKey()).toBe(stored.publicKey);
        expect(readJson(file)).toEqual(stored);
    });

    it("come from the environment when both variables are set, without touching the file", () => {
        const save = savePath();
        const pair = webPush.generateVAPIDKeys();
        const service = createPushService({
            savePath: save,
            env: {
                RISU_WEB_PUSH_VAPID_PUBLIC_KEY: ` ${pair.publicKey} `,
                RISU_WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey,
            },
            transport: fakeTransport().transport,
        });
        expect(service.publicKey()).toBe(pair.publicKey);
        expect(() => readFileSync(serverFile(save, "web_push_vapid.json"))).toThrow();
    });

    it("turn push off for one variable alone, an invalid environment pair, or an unreadable file, which is never replaced", async () => {
        const pair = webPush.generateVAPIDKeys();
        for (const env of [
            { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey },
            { RISU_WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey },
            { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: "nope", RISU_WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey },
            { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey, RISU_WEB_PUSH_VAPID_PRIVATE_KEY: "nope" },
        ]) {
            const save = savePath();
            const service = createPushService({ savePath: save, env, transport: fakeTransport().transport });
            expect(service.publicKey(), JSON.stringify(env)).toBeNull();
            expect(await service.upsert(subscription()), JSON.stringify(env)).toBe(false);
            expect(() => readFileSync(serverFile(save, "web_push_vapid.json"))).toThrow();
        }

        const save = savePath();
        mkdirSync(path.join(save, "server"), { recursive: true });
        writeFileSync(serverFile(save, "web_push_vapid.json"), "{ not json");
        const service = createPushService({ savePath: save, env: {}, transport: fakeTransport().transport });
        expect(service.publicKey()).toBeNull();
        expect(readFileSync(serverFile(save, "web_push_vapid.json"), "utf-8")).toBe("{ not json");
    });

    // `web-push` refuses a padded key on every send (`validatePublicKey`), and a pair mixed from two
    // keys signs with the wrong key; neither may be advertised.
    it("turn push off for a pair the package cannot sign with: padded keys, a mismatched pair, an off-curve point", () => {
        const a = webPush.generateVAPIDKeys();
        const b = webPush.generateVAPIDKeys();
        const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(32, 1), Buffer.alloc(32, 1)]).toString(
            "base64url",
        );
        for (const pair of [
            { publicKey: a.publicKey + "=", privateKey: a.privateKey },
            { publicKey: a.publicKey, privateKey: a.privateKey + "==" },
            { publicKey: a.publicKey, privateKey: b.privateKey },
            { publicKey: offCurve, privateKey: a.privateKey },
            { publicKey: a.publicKey, privateKey: a.privateKey.slice(0, 42) },
        ]) {
            const save = savePath();
            mkdirSync(path.join(save, "server"), { recursive: true });
            writeFileSync(serverFile(save, "web_push_vapid.json"), JSON.stringify(pair));
            const stored = createPushService({ savePath: save, env: {}, transport: fakeTransport().transport });
            expect(stored.publicKey(), JSON.stringify(pair)).toBeNull();
            expect(readJson(serverFile(save, "web_push_vapid.json"))).toEqual(pair);
            const fromEnv = createPushService({
                savePath: savePath(),
                env: {
                    RISU_WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey,
                    RISU_WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey,
                },
                transport: fakeTransport().transport,
            });
            expect(fromEnv.publicKey(), JSON.stringify(pair)).toBeNull();
        }
        // The pair itself, and a browser-style padded `p256dh`, are fine.
        const good = createPushService({
            savePath: savePath(),
            env: { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: a.publicKey, RISU_WEB_PUSH_VAPID_PRIVATE_KEY: a.privateKey },
            transport: fakeTransport().transport,
        });
        expect(good.publicKey()).toBe(a.publicKey);
    });

    it("turn push off for a contact that is not a mailto: or https: URL (what the package's VAPID subject allows)", () => {
        for (const [contact, enabled] of [
            ["mailto:ops@example.com", true],
            ["https://example.com/contact", true],
            ["", true],
            ["ops@example.com", false],
            ["http://example.com/contact", false],
            ["not a url", false],
        ] as const) {
            const service = createPushService({
                savePath: savePath(),
                env: { RISU_WEB_PUSH_CONTACT: contact },
                transport: fakeTransport().transport,
            });
            expect(service.publicKey() !== null, JSON.stringify(contact)).toBe(enabled);
        }
    });
});

describe("the subscriptions", () => {
    it("does not write or refresh a healthy identical registration until it is 24 hours old", async () => {
        const save = savePath();
        const started = 1_900_000_000_000;
        let now = started;
        const options = { savePath: save, env: {}, transport: fakeTransport().transport, now: () => now };
        let push = createPushService(options);
        const sub = subscription();
        const file = serverFile(save, "push_subscriptions.json");
        expect(PUSH_REGISTRATION_REFRESH_MS).toBe(24 * 60 * 60 * 1_000);
        expect(await push.register(sub)).toBe("ok");
        const original = readFileSync(file, "utf8");
        expect(readJson(file).subscriptions[0].updatedAt).toBe(started);
        push.close();
        const { fs, rename } = countedFs();
        push = createPushService({ ...options, fs });
        try {
            now = started + 24 * 60 * 60 * 1_000 - 1;
            expect(await push.register(sub)).toBe("ok");
            expect(rename).not.toHaveBeenCalled();
            expect(readFileSync(file, "utf8")).toBe(original);
            now++;
            expect(await push.register(sub)).toBe("ok");
            expect(rename).toHaveBeenCalledOnce();
            expect(readJson(file).subscriptions).toEqual([{ ...sub, failureCount: 0, updatedAt: now }]);
        } finally {
            push.close();
        }
    });

    it("rewrites changed subscription fields and resets unhealthy registrations even within 24 hours", async () => {
        const save = savePath();
        const started = 1_900_000_000_000;
        const options = { savePath: save, env: {}, transport: fakeTransport().transport, now: () => started + 1 };
        // Create the key and directory through the service before seeding persisted registrations.
        createPushService(options).close();
        const sub = subscription();
        const otherKeys = subscription().keys;
        const file = serverFile(save, "push_subscriptions.json");
        for (const [label, stored, incoming] of [
            ["p256dh", {}, { ...sub, keys: { ...sub.keys, p256dh: otherKeys.p256dh } }],
            ["auth", {}, { ...sub, keys: { ...sub.keys, auth: otherKeys.auth } }],
            ["expirationTime", {}, { ...sub, expirationTime: started + 60_000 }],
            ["failureCount", { failureCount: 1 }, sub],
            ["lastError", { lastError: "HTTP 500" }, sub],
        ] as const) {
            writeFileSync(
                file,
                JSON.stringify({
                    version: 1,
                    subscriptions: [{ ...sub, updatedAt: started, failureCount: 0, ...stored }],
                }),
            );
            const { fs, rename } = countedFs();
            const push = createPushService({ ...options, fs });
            try {
                expect(await push.register(incoming), label).toBe("ok");
                expect(rename, label).toHaveBeenCalledOnce();
                expect(readJson(file).subscriptions, label).toEqual([
                    { ...incoming, failureCount: 0, updatedAt: started + 1 },
                ]);
            } finally {
                push.close();
            }
        }
    });

    it("stores a recent identical subscription again after delivery removal or DELETE", async () => {
        const save = savePath();
        let now = 1_900_000_000_000;
        let status = 410;
        const { transport } = fakeTransport(() => httpError(status));
        const push = createPushService({ savePath: save, env: {}, transport, now: () => now });
        const sub = subscription();
        const file = serverFile(save, "push_subscriptions.json");
        try {
            expect(await push.register(sub)).toBe("ok");
            for (const removal of [404, 410, "DELETE"] as const) {
                if (removal === "DELETE") {
                    expect(await push.remove(sub.endpoint)).toBe(true);
                } else {
                    status = removal;
                    await push.send(NOTIFICATION);
                    await push.drain();
                }
                expect(readJson(file).subscriptions, String(removal)).toEqual([]);
                now++;
                expect(await push.register(sub), String(removal)).toBe("ok");
                expect(readJson(file).subscriptions, String(removal)).toEqual([
                    { ...sub, failureCount: 0, updatedAt: now },
                ]);
            }
        } finally {
            push.close();
        }
    });

    it("rewrites a removal after a failed commit whose rename already landed", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        const { fs, rename } = countedFs();
        let flushFails = true;
        const push = createPushService({
            savePath: save,
            env: {},
            transport: fakeTransport().transport,
            fs: {
                ...fs,
                async open(name, flags, mode) {
                    const handle = await promises.open(name, flags, mode);
                    if (flushFails && name === path.dirname(file)) {
                        handle.sync = async () => {
                            throw Object.assign(new Error("directory flush failed"), { code: "EIO" });
                        };
                    }
                    return handle;
                },
            },
        });
        const sub = subscription();
        expect(await push.register(sub)).toBe("unsaved");
        expect(readJson(file).subscriptions).toEqual([expect.objectContaining({ endpoint: sub.endpoint })]);
        flushFails = false;
        rename.mockClear();
        // Memory never accepted the registration, but disk contains it. Removal must still write.
        try {
            expect(await push.remove(sub.endpoint)).toBe(true);
            expect(readJson(file).subscriptions).toEqual([]);
            expect(rename).toHaveBeenCalledOnce();
        } finally {
            push.close();
        }
    });

    function service(env: NodeJS.ProcessEnv = {}, answer?: (call: Call) => unknown) {
        const save = savePath();
        const fake = fakeTransport(answer);
        return { save, ...fake, service: createPushService({ savePath: save, env, transport: fake.transport }) };
    }

    it("accept a browser's subscription for an allowed push service and store it in save/server/push_subscriptions.json", async () => {
        const { save, service: push } = service();
        const sub = subscription("https://web.push.apple.com/QWxs", { expirationTime: 1_900_000_000_000 });
        expect(await push.upsert(sub)).toBe(true);
        const stored = readJson(serverFile(save, "push_subscriptions.json"));
        expect(stored).toEqual({
            version: 1,
            subscriptions: [
                {
                    endpoint: sub.endpoint,
                    keys: sub.keys,
                    expirationTime: 1_900_000_000_000,
                    failureCount: 0,
                    updatedAt: expect.any(Number),
                },
            ],
        });
        expect(statSync(serverFile(save, "push_subscriptions.json")).mode & 0o777).toBe(0o600);
        // Registered again: one entry, the newer keys.
        const renewed = { ...sub, keys: subscription().keys };
        expect(await push.upsert(renewed)).toBe(true);
        expect(readJson(serverFile(save, "push_subscriptions.json")).subscriptions).toEqual([
            expect.objectContaining({ endpoint: sub.endpoint, keys: renewed.keys }),
        ]);
    });

    it("accept every default push host, the subdomain patterns, and RISU_WEB_PUSH_ALLOWED_HOSTS", async () => {
        const { service: push } = service({ RISU_WEB_PUSH_ALLOWED_HOSTS: " push.example.org , .ntfy.example.net " });
        for (const endpoint of [
            "https://fcm.googleapis.com/fcm/send/x",
            "https://android.googleapis.com/gcm/send/x",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://web.push.apple.com/x",
            "https://abc.push.apple.com/x",
            "https://db5p.notify.windows.com/w/?token=x",
            "https://push.example.org/sub/1",
            "https://a.ntfy.example.net/sub/1",
            "https://FCM.GOOGLEAPIS.COM/upper",
        ]) {
            expect(await push.upsert(subscription(endpoint)), endpoint).toBe(true);
        }
    });

    it("refuse endpoints outside the allowed hosts, other schemes, ports, credentials, fragments, and oversized ones", async () => {
        const { save, service: push } = service();
        for (const endpoint of [
            "http://fcm.googleapis.com/fcm/send/x",
            "https://evil.example.com/fcm.googleapis.com",
            "https://fcm.googleapis.com.evil.example/x",
            "https://notfcm.googleapis.com/x",
            "https://push.apple.com/x",
            "https://fcm.googleapis.com:8443/x",
            "https://user:pw@fcm.googleapis.com/x",
            "https://fcm.googleapis.com/x#frag",
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "ftp://fcm.googleapis.com/x",
            "fcm.googleapis.com/x",
            `${ALLOWED}${"a".repeat(4096)}`,
            "",
        ]) {
            expect(await push.upsert(subscription(endpoint)), endpoint).toBe(false);
        }
        expect(() => readFileSync(serverFile(save, "push_subscriptions.json"))).toThrow();
    });

    it("refuse malformed shapes and keys: a missing or non-P-256 p256dh, an auth secret of another size, a bad expirationTime", async () => {
        const { service: push } = service();
        const ok = subscription();
        const bad: unknown[] = [
            null,
            "string",
            [ok],
            { ...ok, keys: null },
            { ...ok, keys: { auth: ok.keys.auth } },
            { ...ok, keys: { ...ok.keys, p256dh: ok.keys.p256dh.slice(1) } },
            { ...ok, keys: { ...ok.keys, p256dh: "A" + ok.keys.p256dh.slice(1) } },
            { ...ok, keys: { ...ok.keys, p256dh: ok.keys.p256dh.replace(/[-_]/g, "+") + "!" } },
            { ...ok, keys: { ...ok.keys, auth: randomBytes(15).toString("base64url") } },
            { ...ok, keys: { ...ok.keys, auth: randomBytes(17).toString("base64url") } },
            { ...ok, keys: { ...ok.keys, auth: 16 } },
            { ...ok, expirationTime: "soon" },
            { ...ok, expirationTime: Number.NaN },
            { ...ok, expirationTime: {} },
        ];
        for (const [index, raw] of bad.entries()) {
            expect(await push.upsert(raw), `case ${index}`).toBe(false);
        }
        expect(await push.upsert({ ...ok, expirationTime: undefined })).toBe(true);
    });

    it("drop invalid rows and a host no longer allowed when loading the file, dedupe endpoints, and keep the newest 50", async () => {
        const save = savePath();
        mkdirSync(path.join(save, "server"), { recursive: true });
        const kept = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS + 5 }, (_, i) => ({
            ...subscription(`${ALLOWED}row-${i}`),
            failureCount: i === 0 ? 3 : 0,
            updatedAt: 1000 + i,
        }));
        const rows = [
            "junk",
            { ...subscription("https://evil.example.com/x"), updatedAt: 9_999_999 },
            { ...subscription(), keys: { p256dh: "nope", auth: "nope" }, updatedAt: 9_999_999 },
            { ...kept[1], keys: subscription().keys, updatedAt: 1 },
            ...kept,
        ];
        writeFileSync(serverFile(save, "push_subscriptions.json"), JSON.stringify({ version: 1, subscriptions: rows }));
        const { calls, transport } = fakeTransport();
        const push = createPushService({ savePath: save, env: {}, transport });
        await push.send(NOTIFICATION);
        const endpoints = calls.map((call) => call.subscription.endpoint).sort();
        // The five oldest (`row-0`..`row-4`, the lowest `updatedAt`) fall past the cap; the duplicate of
        // `row-1` (older) is not a second entry.
        expect(endpoints).toEqual(
            kept
                .slice(5)
                .map((row) => row.endpoint)
                .sort(),
        );
        expect(endpoints).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
        expect(calls.filter((call) => call.subscription.endpoint === kept[1].endpoint)).toHaveLength(0);
        for (const call of calls) {
            expect(call.subscription.keys).toEqual(
                kept.find((row) => row.endpoint === call.subscription.endpoint)!.keys,
            );
        }
    });

    it("registering one past the cap drops the least recently registered", async () => {
        const { save, service: push } = service();
        const subs = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS + 1 }, () => subscription());
        for (const [i, sub] of subs.entries()) {
            vi.setSystemTime(1_700_000_000_000 + i * 1000);
            expect(await push.upsert(sub)).toBe(true);
        }
        vi.useRealTimers();
        const stored = readJson(serverFile(save, "push_subscriptions.json")).subscriptions as { endpoint: string }[];
        expect(stored).toHaveLength(MAX_PUSH_SUBSCRIPTIONS);
        expect(stored.map((row) => row.endpoint)).not.toContain(subs[0].endpoint);
        expect(stored[0].endpoint).toBe(subs.at(-1)!.endpoint);
    });

    it("a non-JSON file starts without subscriptions, and remove ignores an unknown endpoint and a non-URL", async () => {
        const save = savePath();
        mkdirSync(path.join(save, "server"), { recursive: true });
        writeFileSync(serverFile(save, "push_subscriptions.json"), "{{{");
        const { calls, transport } = fakeTransport();
        const push = createPushService({ savePath: save, env: {}, transport });
        await push.remove("https://fcm.googleapis.com/fcm/send/none");
        await push.remove(42);
        await push.send(NOTIFICATION);
        expect(calls).toHaveLength(0);
        const sub = subscription();
        expect(await push.upsert(sub)).toBe(true);
        await push.remove(sub.endpoint);
        expect(readJson(serverFile(save, "push_subscriptions.json")).subscriptions).toEqual([]);
    });

    // `new URL()` decodes `%2e` in the host (`127.0.0.1.notify.windows.com` passes the allowlist)
    // while `web-push` posts with the legacy `url.parse()`, whose hostname of the same string is
    // `127.0.0.1`; a host character the WHATWG parser keeps (`'`, `"`, `;`, a backtick, `{`, `}`)
    // ends the host for `url.parse` the same way. Only a plain DNS name is allowed.
    it("refuses a host spelled with escapes or punctuation that the transport's URL parser would read differently", async () => {
        const { service: push } = service();
        const punctuation = [
            "'",
            '"',
            ";",
            "`",
            "{",
            "}",
            "%27",
            "%22",
            "%3b",
            "%60",
            "%7b",
            "%7d",
            "_",
            "~",
            "!",
            "$",
            "(",
            ")",
            "*",
            "+",
            ",",
        ];
        for (const mark of punctuation) {
            for (const endpoint of [
                `https://127.0.0.1${mark}.notify.windows.com/push`,
                `https://127.0.0.1${mark}notify.windows.com/push`,
                `https://fcm.googleapis.com${mark}evil.test/push`,
                `https://evil.test${mark}fcm.googleapis.com/push`,
            ]) {
                expect(await push.upsert(subscription(endpoint)), endpoint).toBe(false);
            }
        }
        for (const endpoint of [
            "https://fcm.googleapis.com./push",
            "https://fcm.googleapis.com%2e/push",
            "https://xn--fcm-googleapis.com/push",
            "https://fcm-.googleapis.com/push",
            "https://-fcm.googleapis.com/push",
            `https://${"a".repeat(64)}.notify.windows.com/push`,
        ]) {
            expect(await push.upsert(subscription(endpoint)), JSON.stringify(endpoint)).toBe(false);
        }
    });

    it("stores and posts the canonical href, which the transport's parser reads as the same allowed host and path", async () => {
        const { calls, save, service: push } = service();
        const spellings = [
            "https://FCM.googleapis.com/fcm/send/ABC",
            "https://fcm.googleapis.com/fcm/send/a%2fb?x=%27y#",
            "https://fcm.googleapis.com/fcm\\send/@evil.test/x",
            "https://fcm.googleapis.com/fcm/send/'x'{y};z",
            "https://fcm.googleapis.com/fcm/send/%2e%2e/up",
            "https://fcm.googleapis.com/fcm/send/あ",
            "https://fcm.googleapis.com:443/fcm/send/port",
            "https://fcm.googleapis.com/fcm/send/q?a=1&b=%00",
            "https://web.push.apple.com/%E2%80%8B",
            "https://x.notify.windows.com/w/?token=a%3Db%26c",
            "https://fcm.googleapis.com\t/push\n",
        ];
        for (const spelling of spellings) {
            expect(await push.upsert(subscription(spelling)), spelling).toBe(true);
        }
        await push.send(NOTIFICATION);
        expect(calls).toHaveLength(spellings.length);
        const stored = readJson(serverFile(save, "push_subscriptions.json")).subscriptions as { endpoint: string }[];
        for (const call of calls) {
            const endpoint = call.subscription.endpoint;
            const whatwg = new URL(endpoint);
            const legacy = url.parse(endpoint);
            expect(endpoint, endpoint).toBe(whatwg.href);
            expect(legacy.hostname, endpoint).toBe(whatwg.hostname);
            // (`url.parse` re-escapes `'` in a path; the same resource once decoded.)
            expect(decodeURI(legacy.path!), endpoint).toBe(decodeURI(whatwg.pathname + whatwg.search));
            expect(legacy.auth, endpoint).toBeNull();
            expect(legacy.port, endpoint).toBeNull();
            expect(["fcm.googleapis.com", "web.push.apple.com", "x.notify.windows.com"]).toContain(whatwg.hostname);
            expect(
                stored.some((row) => row.endpoint === endpoint),
                endpoint,
            ).toBe(true);
        }
        // A removal in a noncanonical spelling finds the canonical entry.
        expect(await push.remove("https://FCM.googleapis.com:443/fcm/send/ABC")).toBe(true);
        expect(
            readJson(serverFile(save, "push_subscriptions.json")).subscriptions.map(
                (row: { endpoint: string }) => row.endpoint,
            ),
        ).not.toContain("https://fcm.googleapis.com/fcm/send/ABC");
    });

    it("canonicalizes or drops noncanonical endpoints read from the file", async () => {
        const save = savePath();
        mkdirSync(path.join(save, "server"), { recursive: true });
        const rows = [
            { ...subscription("https://FCM.googleapis.com:443/fcm/send/Upper"), updatedAt: 3 },
            { ...subscription("https://127.0.0.1%2enotify.windows.com/push"), updatedAt: 2 },
            { ...subscription("https://127.0.0.1'.notify.windows.com/push"), updatedAt: 1 },
        ];
        writeFileSync(serverFile(save, "push_subscriptions.json"), JSON.stringify({ version: 1, subscriptions: rows }));
        const { calls, transport } = fakeTransport();
        const push = createPushService({ savePath: save, env: {}, transport });
        await push.send(NOTIFICATION);
        // `%2e` canonicalizes to a dot (an allowed subdomain, which `url.parse` reads the same way);
        // the quote stays in the WHATWG host and the row is dropped.
        expect(calls.map((call) => call.subscription.endpoint)).toEqual([
            "https://fcm.googleapis.com/fcm/send/Upper",
            "https://127.0.0.1.notify.windows.com/push",
        ]);
        for (const call of calls) {
            expect(url.parse(call.subscription.endpoint).hostname).toBe(new URL(call.subscription.endpoint).hostname);
        }
    });

    it("refuses an off-curve p256dh and stores a browser's padded keys unpadded", async () => {
        const { calls, save, service: push } = service();
        const offCurve = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(32, 1), Buffer.alloc(32, 1)]).toString(
            "base64url",
        );
        const ok = subscription();
        expect(await push.upsert({ ...ok, keys: { ...ok.keys, p256dh: offCurve } })).toBe(false);
        const padded = { ...ok, keys: { p256dh: ok.keys.p256dh + "=", auth: ok.keys.auth + "==" } };
        expect(await push.upsert(padded)).toBe(true);
        expect(readJson(serverFile(save, "push_subscriptions.json")).subscriptions[0].keys).toEqual(ok.keys);
        await push.send(NOTIFICATION);
        expect(calls[0].subscription.keys).toEqual(ok.keys);
    });

    // A registration or removal is acknowledged only once the file holds it.
    it("reports a registration or removal whose persistence failed, and changes nothing in memory", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        const { calls, transport } = fakeTransport();
        const push = createPushService({ savePath: save, env: {}, transport });
        const kept = subscription();
        expect(await push.register(kept)).toBe("ok");
        // The file's place is taken by a directory: the rename of the temporary file fails.
        rmSync(file);
        mkdirSync(file);
        expect(await push.register(subscription())).toBe("unsaved");
        expect(await push.upsert(subscription())).toBe(false);
        expect(await push.remove(kept.endpoint)).toBe(false);
        await push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint)).toEqual([kept.endpoint]);
        expect(await push.register("junk")).toBe("invalid");
        const off = createPushService({
            savePath: savePath(),
            env: { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: "lonely" },
            transport: fakeTransport().transport,
        });
        expect(await off.register(subscription())).toBe("disabled");
    });

    it("a removal after a 404/410 whose bookkeeping write failed still writes the file (the disk may hold the entry)", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        let answer: unknown;
        const { transport } = fakeTransport(() => answer);
        const push = createPushService({ savePath: save, env: {}, transport });
        const gone = subscription();
        expect(await push.register(gone)).toBe("ok");
        rmSync(file);
        mkdirSync(file);
        answer = httpError(410);
        await push.send(NOTIFICATION);
        await push.drain();
        // Memory dropped it, the file (a directory for now) still holds it as far as the service knows.
        rmSync(file, { recursive: true });
        expect(await push.remove(gone.endpoint)).toBe(true);
        expect(readJson(file)).toEqual({ version: 1, subscriptions: [] });
        // Nothing uncertain any more: removing an unknown endpoint writes nothing.
        rmSync(file);
        expect(await push.remove("https://fcm.googleapis.com/fcm/send/unknown")).toBe(true);
        expect(() => readFileSync(file)).toThrow();
    });

    it("a removal racing a delivery that just dropped the endpoint (410) writes the file", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let seen!: () => void;
        const removed = new Promise<void>((resolve) => {
            seen = resolve;
        });
        const gone = subscription();
        const slow = subscription();
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        const transport: PushTransport = {
            sendNotification: vi.fn(async (sub: { endpoint: string }) => {
                if (sub.endpoint === gone.endpoint) {
                    throw httpError(410);
                }
                await gate;
                return { statusCode: 201, body: "", headers: {} };
            }) as unknown as PushTransport["sendNotification"],
        };
        // The event is recorded in the step that leaves the outcome for the next operation.
        const diagnostics = {
            record: (event: DiagnosticEventInput) => {
                if (event.phase === "removed") {
                    seen();
                }
            },
        };
        const push = createPushService({ savePath: save, env: {}, transport, diagnostics });
        await push.register(gone);
        await push.register(slow);
        const sending = push.send(NOTIFICATION);
        await removed;
        // The file still has `gone`, and the bookkeeping waits for the other delivery. The removal
        // applies the outcome first, so memory lacks `gone` when it looks, and it must write anyway.
        expect(await push.remove(gone.endpoint)).toBe(true);
        expect(readJson(file).subscriptions.map((row: { endpoint: string }) => row.endpoint)).toEqual([slow.endpoint]);
        release();
        await sending;
        await push.drain();
        expect(readJson(file).subscriptions.map((row: { endpoint: string }) => row.endpoint)).toEqual([slow.endpoint]);
    });

    it("a file that cannot be read is never overwritten: registrations and removals fail until it can, then keep its entries", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        const { calls, transport } = fakeTransport();
        // A directory in the file's place exists but cannot be read as a file.
        mkdirSync(file, { recursive: true });
        const push = createPushService({ savePath: save, env: {}, transport });
        expect(await push.register(subscription())).toBe("unsaved");
        expect(await push.remove("https://fcm.googleapis.com/fcm/send/x")).toBe(false);
        await push.send(NOTIFICATION);
        expect(calls).toHaveLength(0);
        // Readable again, with an entry of its own: the next operation loads it and keeps it.
        rmSync(file, { recursive: true });
        const existing = subscription();
        writeFileSync(file, JSON.stringify({ version: 1, subscriptions: [{ ...existing, updatedAt: 5 }] }));
        const added = subscription();
        expect(await push.register(added)).toBe("ok");
        expect(
            readJson(file)
                .subscriptions.map((row: { endpoint: string }) => row.endpoint)
                .sort(),
        ).toEqual([existing.endpoint, added.endpoint].sort());
        await push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint).sort()).toEqual(
            [existing.endpoint, added.endpoint].sort(),
        );
    });

    it("a file that becomes readable after startup gets deliveries without a registration", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        const { calls, transport } = fakeTransport();
        mkdirSync(file, { recursive: true });
        const push = createPushService({ savePath: save, env: {}, transport });
        await push.send(NOTIFICATION);
        expect(calls).toHaveLength(0);
        // Readable now; no PUT or DELETE runs before the next delivery.
        rmSync(file, { recursive: true });
        const existing = subscription();
        writeFileSync(file, JSON.stringify({ version: 1, subscriptions: [{ ...existing, updatedAt: 5 }] }));
        await push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint)).toEqual([existing.endpoint]);
        expect(readJson(file).subscriptions).toEqual([expect.objectContaining({ endpoint: existing.endpoint })]);
    });

    it("a file that is not JSON starts empty and is replaced by the first write, also a removal", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        mkdirSync(path.join(save, "server"), { recursive: true });
        writeFileSync(file, "{{{");
        const push = createPushService({ savePath: save, env: {}, transport: fakeTransport().transport });
        expect(await push.remove("https://fcm.googleapis.com/fcm/send/unknown")).toBe(true);
        expect(readJson(file)).toEqual({ version: 1, subscriptions: [] });
        const sub = subscription();
        expect(await push.register(sub)).toBe("ok");
        expect(readJson(file).subscriptions).toEqual([expect.objectContaining({ endpoint: sub.endpoint })]);
    });
});

describe("delivery", () => {
    function delivering(answer?: (call: Call) => unknown) {
        const save = savePath();
        const fake = fakeTransport(answer);
        const push = createPushService({
            savePath: save,
            env: { RISU_WEB_PUSH_CONTACT: "mailto:ops@example.com" },
            transport: fake.transport,
        });
        return { save, push, ...fake, file: serverFile(save, "push_subscriptions.json") };
    }

    it("sends the serialized notification to every subscription with the TTL, high urgency, timeout, and per-call VAPID details, and no topic for the bare tag", async () => {
        const { push, calls, save } = delivering();
        const a = subscription();
        const b = subscription("https://updates.push.services.mozilla.com/wpush/v2/b");
        await push.upsert(a);
        await push.upsert(b);
        await push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
        const keys = readJson(serverFile(save, "web_push_vapid.json"));
        for (const call of calls) {
            expect(JSON.parse(call.payload)).toEqual(NOTIFICATION);
            expect(call.subscription.keys).toEqual((call.subscription.endpoint === a.endpoint ? a : b).keys);
            expect(call.options).toEqual({
                TTL: 3600,
                urgency: "high",
                timeout: 10_000,
                vapidDetails: {
                    subject: "mailto:ops@example.com",
                    publicKey: keys.publicKey,
                    privateKey: keys.privateKey,
                },
            });
        }
    });

    it("sends each chat's completion under that chat's own topic, within the RFC 8030 format", async () => {
        const { push, calls } = delivering();
        await push.upsert(subscription());
        // The last chat repeats the first; the long and unusual ids still hash to a short topic.
        const tags = [
            completionNotificationTag("c", "a"),
            completionNotificationTag("c", "b"),
            completionNotificationTag("d", "a"),
            completionNotificationTag("a".repeat(500), "\u0000한글/?#"),
            completionNotificationTag("c", "a"),
        ];
        for (const tag of tags) {
            await push.send({ ...NOTIFICATION, tag });
        }
        const topics = calls.map((call) => call.options.topic);
        expect(topics).toEqual(tags.map((tag) => tag.slice(`${COMPLETION_NOTIFICATION_TAG}:`.length)));
        for (const topic of topics) {
            expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
        }
        expect(new Set(topics.slice(0, 4)).size).toBe(4);
        expect(topics[4]).toBe(topics[0]);
        expect(calls.every((call) => call.options.urgency === "high")).toBe(true);
    });

    it("removes a subscription the push service reports gone (404, 410), counts other failures with a sanitized label, and clears them on success", async () => {
        let failures: Record<string, unknown> = {};
        const { push, calls, file } = delivering((call) => failures[call.subscription.endpoint]);
        const gone = subscription();
        const missing = subscription();
        const flaky = subscription();
        const offline = subscription();
        for (const sub of [gone, missing, flaky, offline]) {
            await push.upsert(sub);
        }
        failures = {
            [gone.endpoint]: httpError(410),
            [missing.endpoint]: httpError(404),
            [flaky.endpoint]: httpError(500),
            [offline.endpoint]: new Error("ECONNRESET https://secret.example/token"),
        };
        await push.send(NOTIFICATION);
        await push.drain();
        let stored = readJson(file).subscriptions as any[];
        expect(stored.map((row) => row.endpoint).sort()).toEqual([flaky.endpoint, offline.endpoint].sort());
        expect(stored.find((row) => row.endpoint === flaky.endpoint)).toMatchObject({
            failureCount: 1,
            lastError: "HTTP 500",
        });
        expect(stored.find((row) => row.endpoint === offline.endpoint)).toMatchObject({
            failureCount: 1,
            lastError: "network",
        });
        expect(JSON.stringify(stored)).not.toContain("secret.example");

        failures = { [flaky.endpoint]: httpError(502) };
        await push.send(NOTIFICATION);
        await push.drain();
        stored = readJson(file).subscriptions;
        expect(stored.find((row) => row.endpoint === flaky.endpoint)).toMatchObject({
            failureCount: 2,
            lastError: "HTTP 502",
        });
        const recovered = stored.find((row) => row.endpoint === offline.endpoint);
        expect(recovered.failureCount).toBe(0);
        expect(recovered).not.toHaveProperty("lastError");
        expect(calls.filter((call) => call.subscription.endpoint === gone.endpoint)).toHaveLength(1);
    });

    it("applies a delivery result only to the entry still holding the keys it was sent with", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let inFlight!: () => void;
        const started = new Promise<void>((resolve) => {
            inFlight = resolve;
        });
        const save = savePath();
        const transport: PushTransport = {
            sendNotification: vi.fn(async () => {
                inFlight();
                await gate;
                throw httpError(410);
            }) as unknown as PushTransport["sendNotification"],
        };
        const push = createPushService({ savePath: save, env: {}, transport });
        const sub = subscription();
        await push.upsert(sub);
        const sending = push.send(NOTIFICATION);
        await started;
        // The browser registered again with new keys while the old send is in flight.
        const renewed = { ...sub, keys: subscription().keys };
        await push.upsert(renewed);
        release();
        await sending;
        await push.drain();
        expect(readJson(serverFile(save, "push_subscriptions.json")).subscriptions).toEqual([
            expect.objectContaining({ endpoint: sub.endpoint, keys: renewed.keys, failureCount: 0 }),
        ]);
    });

    it("delivers completions one at a time in order, drops those past the queue, never rejects, and stops after close", async () => {
        const gates: (() => void)[] = [];
        const started: string[] = [];
        const save = savePath();
        const transport: PushTransport = {
            sendNotification: vi.fn(async (_sub: any, payload: any) => {
                started.push(JSON.parse(String(payload)).body);
                await new Promise<void>((resolve) => gates.push(resolve));
                return { statusCode: 201, body: "", headers: {} };
            }) as unknown as PushTransport["sendNotification"],
        };
        const push = createPushService({ savePath: save, env: {}, transport });
        await push.upsert(subscription());
        const sends = Array.from({ length: 8 }, (_, i) => push.send({ ...NOTIFICATION, body: `n${i}` }));
        await nextTurn();
        expect(started).toEqual(["n0"]);
        while (gates.length > 0 || started.length < 4) {
            gates.shift()?.();
            await nextTurn();
        }
        await Promise.all(sends);
        // The queue admits a bounded number; the later ones were dropped (the tag collapses them anyway).
        expect(started.length).toBeGreaterThanOrEqual(4);
        expect(started.length).toBeLessThan(8);
        expect(started).toEqual(started.map((_, i) => `n${i}`));

        const sync: PushTransport = {
            sendNotification: vi.fn(() => {
                throw new Error("sync throw");
            }) as unknown as PushTransport["sendNotification"],
        };
        const throwing = createPushService({ savePath: savePath(), env: {}, transport: sync });
        await throwing.upsert(subscription());
        await expect(throwing.send(NOTIFICATION)).resolves.toBeUndefined();

        push.close();
        started.length = 0;
        await push.send(NOTIFICATION);
        expect(started).toEqual([]);
    });

    it("sends nothing while push is off", async () => {
        const save = savePath();
        const { calls, transport } = fakeTransport();
        const push = createPushService({
            savePath: save,
            env: { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: "lonely" },
            transport,
        });
        await push.send(NOTIFICATION);
        expect(calls).toHaveLength(0);
    });
});

describe("the push diagnostics", () => {
    const JOB = "0f6c2b1e-9a7d-4c3e-8b21-5d4e6f7a8b9c";
    /** A recorder that keeps every event it is handed. */
    function recorder() {
        const events: DiagnosticEventInput[] = [];
        return { events, diagnostics: { record: (input: DiagnosticEventInput) => void events.push(input) } };
    }
    function delivering(answer?: (call: Call) => unknown, env: NodeJS.ProcessEnv = {}) {
        const save = savePath();
        const fake = fakeTransport(answer);
        const { events, diagnostics } = recorder();
        const push = createPushService({ savePath: save, env, transport: fake.transport, diagnostics });
        return { save, push, events, ...fake, file: serverFile(save, "push_subscriptions.json") };
    }
    const byPhase = (events: DiagnosticEventInput[], phase: string) => events.filter((event) => event.phase === phase);

    it("records one event per subscription a completion was sent to: `accepted`, `failed` with the status the service answered (none for a network failure), `removed` for 404 and 410, each named by its push service and the job, never by its endpoint, and the job never enters the payload", async () => {
        let failures: Record<string, unknown> = {};
        const { push, calls, events } = delivering((call) => failures[call.subscription.endpoint]);
        const fcm = subscription();
        const android = subscription("https://android.googleapis.com/gcm/send/a");
        const mozilla = subscription("https://updates.push.services.mozilla.com/wpush/v2/m");
        const apple = subscription("https://web.push.apple.com/alice-secret");
        const windows = subscription("https://db5p.notify.windows.com/w/?token=x");
        for (const sub of [fcm, android, mozilla, apple, windows]) {
            await push.upsert(sub);
        }
        failures = {
            [android.endpoint]: httpError(410),
            [mozilla.endpoint]: httpError(404),
            [apple.endpoint]: httpError(500),
            [windows.endpoint]: new Error("ECONNRESET https://secret.example/token"),
        };
        await push.send(NOTIFICATION, { jobId: JOB });
        expect(calls).toHaveLength(5);
        const sorted = [...events].sort((a, b) => String(a.service).localeCompare(String(b.service)));
        expect(sorted).toEqual([
            { kind: "push", phase: "failed", service: "apple", jobId: JOB, status: 500 },
            { kind: "push", phase: "removed", service: "fcm", jobId: JOB },
            { kind: "push", phase: "accepted", service: "fcm", jobId: JOB },
            { kind: "push", phase: "removed", service: "mozilla", jobId: JOB },
            { kind: "push", phase: "failed", service: "windows", jobId: JOB, status: null },
        ]);
        expect(JSON.stringify(events)).not.toMatch(/googleapis|mozilla\.com|apple\.com|windows\.com|secret|token|Ann/);
        for (const call of calls) {
            expect(call.payload).not.toContain(JOB);
            expect(JSON.stringify(call.options)).not.toContain(JOB);
        }
        // A host outside the known services is `other`; a send without a job has no job id.
        const { push: extra, events: extraEvents } = delivering(undefined, {
            RISU_WEB_PUSH_ALLOWED_HOSTS: "push.example.org",
        });
        await extra.upsert(subscription("https://push.example.org/sub/1"));
        await extra.send(NOTIFICATION);
        expect(extraEvents).toEqual([{ kind: "push", phase: "accepted", service: "other", jobId: undefined }]);
    });

    it("records one `dropped` with its reason when nothing is sent: push off (`noKeys`), no subscriptions, an unreadable file, a full queue, and a closed service (also for a send queued before the close)", async () => {
        const off = delivering(undefined, { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: "lonely" });
        await off.push.send(NOTIFICATION, { jobId: JOB });
        expect(off.events).toEqual([{ kind: "push", phase: "dropped", reason: "noKeys", jobId: JOB }]);
        expect(off.calls).toHaveLength(0);

        const empty = delivering();
        await empty.push.send(NOTIFICATION, { jobId: JOB });
        expect(empty.events).toEqual([{ kind: "push", phase: "dropped", reason: "noSubscriptions", jobId: JOB }]);

        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        mkdirSync(file, { recursive: true });
        const { events: unreadableEvents, diagnostics } = recorder();
        const unreadable = createPushService({
            savePath: save,
            env: {},
            transport: fakeTransport().transport,
            diagnostics,
        });
        await unreadable.send(NOTIFICATION, { jobId: JOB });
        expect(unreadableEvents).toEqual([{ kind: "push", phase: "dropped", reason: "unreadable", jobId: JOB }]);

        const gates: (() => void)[] = [];
        const { events: queued, diagnostics: queueRecorder } = recorder();
        const slow = createPushService({
            savePath: savePath(),
            env: {},
            transport: {
                sendNotification: vi.fn(async () => {
                    await new Promise<void>((resolve) => gates.push(resolve));
                    return { statusCode: 201, body: "", headers: {} };
                }) as unknown as PushTransport["sendNotification"],
            },
            diagnostics: queueRecorder,
        });
        await slow.upsert(subscription());
        const sends = Array.from({ length: 8 }, () => slow.send(NOTIFICATION, { jobId: JOB }));
        // The sends past the queue are dropped at once, each with its own event.
        const full = byPhase(queued, "dropped");
        expect(full.length).toBeGreaterThan(0);
        expect(full).toEqual(full.map(() => ({ kind: "push", phase: "dropped", reason: "queueFull", jobId: JOB })));
        // The service closes while the first delivery is in flight: the ones queued behind it are dropped as closed.
        while (gates.length === 0) {
            await nextTurn();
        }
        slow.close();
        while (gates.length > 0) {
            gates.shift()!();
            await nextTurn();
        }
        await Promise.all(sends);
        expect(byPhase(queued, "accepted")).toEqual([{ kind: "push", phase: "accepted", service: "fcm", jobId: JOB }]);
        const closed = queued.filter((event) => event.reason === "closed");
        expect(closed.length).toBe(8 - 1 - full.length);
        await slow.send(NOTIFICATION, { jobId: JOB });
        expect(queued.filter((event) => event.reason === "closed")).toHaveLength(closed.length + 1);
        expect(queued).toHaveLength(8 + 1);
    });

    it("records the transport's outcome of a subscription registered again with new keys meanwhile, whose entry the outcome no longer touches", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let inFlight!: () => void;
        const started = new Promise<void>((resolve) => {
            inFlight = resolve;
        });
        const save = savePath();
        const { events, diagnostics } = recorder();
        const transport: PushTransport = {
            sendNotification: vi.fn(async () => {
                inFlight();
                await gate;
                throw httpError(410);
            }) as unknown as PushTransport["sendNotification"],
        };
        const push = createPushService({ savePath: save, env: {}, transport, diagnostics });
        const sub = subscription();
        await push.upsert(sub);
        const sending = push.send(NOTIFICATION, { jobId: JOB });
        await started;
        const renewed = { ...sub, keys: subscription().keys };
        await push.upsert(renewed);
        release();
        await sending;
        await push.drain();
        expect(events).toEqual([{ kind: "push", phase: "removed", service: "fcm", jobId: JOB }]);
        expect(readJson(serverFile(save, "push_subscriptions.json")).subscriptions).toEqual([
            expect.objectContaining({ endpoint: sub.endpoint, keys: renewed.keys, failureCount: 0 }),
        ]);
    });

    it("delivers, removes, and counts exactly as without a recorder when the recorder throws, and the send still resolves", async () => {
        let failures: Record<string, unknown> = {};
        const save = savePath();
        const { calls, transport } = fakeTransport((call) => failures[call.subscription.endpoint]);
        const throwing = {
            record: vi.fn(() => {
                throw new Error("journal closed");
            }),
        };
        const push = createPushService({ savePath: save, env: {}, transport, diagnostics: throwing });
        const gone = subscription();
        const flaky = subscription();
        const fine = subscription();
        for (const sub of [gone, flaky, fine]) {
            await push.upsert(sub);
        }
        failures = { [gone.endpoint]: httpError(410), [flaky.endpoint]: httpError(500) };
        await expect(push.send(NOTIFICATION, { jobId: JOB })).resolves.toBeUndefined();
        await push.drain();
        expect(throwing.record).toHaveBeenCalledTimes(3);
        expect(calls.map((call) => call.subscription.endpoint).sort()).toEqual(
            [gone.endpoint, flaky.endpoint, fine.endpoint].sort(),
        );
        const stored = readJson(serverFile(save, "push_subscriptions.json")).subscriptions as any[];
        expect(stored.map((row) => row.endpoint).sort()).toEqual([flaky.endpoint, fine.endpoint].sort());
        expect(stored.find((row) => row.endpoint === flaky.endpoint)).toMatchObject({
            failureCount: 1,
            lastError: "HTTP 500",
        });
        expect(stored.find((row) => row.endpoint === fine.endpoint)).toMatchObject({ failureCount: 0 });
        // A dropped send is as quiet.
        push.close();
        await expect(push.send(NOTIFICATION)).resolves.toBeUndefined();
        expect(throwing.record).toHaveBeenCalledTimes(4);
    });
});

describe("the push routes", () => {
    const servers: ReturnType<typeof createTestServer>[] = [];
    afterEach(async () => {
        await Promise.all(servers.splice(0).map((s) => s.close()));
    });

    async function authed(options: Parameters<typeof createTestServer>[0] = {}) {
        const s = createTestServer({ password: "pw", ...options });
        servers.push(s);
        const signer = await createSigner();
        await s.app.request("/api/login", json({ password: "pw", publicKey: signer.publicJwk }));
        const headers = async (extra: Record<string, string> = {}) => ({ "risu-auth": await signer.jwt(), ...extra });
        const request = async (method: string, route: string, body?: unknown, extra: Record<string, string> = {}) =>
            s.app.request(route, {
                method,
                headers: await headers(body === undefined ? extra : { "content-type": "application/json", ...extra }),
                ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
            });
        return { ...s, headers, request };
    }
    const KEY = "/api/push/key";
    const SUB = "/api/push/subscription";

    it("answers the public key and registers and removes a subscription, all no-store", async () => {
        const { calls, transport } = fakeTransport();
        const s = await authed({ pushTransport: transport });
        const key = await s.request("GET", KEY);
        expect(key.status).toBe(200);
        expect(key.headers.get("cache-control")).toBe("no-store");
        const stored = readJson(path.join(s.savePath, "server", "web_push_vapid.json"));
        expect(await key.json()).toEqual({ publicKey: stored.publicKey });

        const sub = subscription();
        const put = await s.request("PUT", SUB, { subscription: sub });
        expect(put.status).toBe(204);
        expect(put.headers.get("cache-control")).toBe("no-store");
        expect(readJson(path.join(s.savePath, "server", "push_subscriptions.json")).subscriptions).toEqual([
            expect.objectContaining({ endpoint: sub.endpoint, keys: sub.keys }),
        ]);
        await s.context.push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint)).toEqual([sub.endpoint]);

        const del = await s.request("DELETE", SUB, { endpoint: sub.endpoint });
        expect(del.status).toBe(204);
        expect(del.headers.get("cache-control")).toBe("no-store");
        expect(readJson(path.join(s.savePath, "server", "push_subscriptions.json")).subscriptions).toEqual([]);
        // Idempotent.
        expect((await s.request("DELETE", SUB, { endpoint: sub.endpoint })).status).toBe(204);
        // The storage routes never reach the push files.
        for (const file of ["server/push_subscriptions.json", "server/web_push_vapid.json"]) {
            const read = await s.app.request("/api/read", {
                headers: await s.headers({ "file-path": Buffer.from(file).toString("hex") }),
            });
            expect(await read.text(), file).toBe("");
        }
    });

    it("authenticates every route before reading a body, with checkAuth's own answers", async () => {
        const s = await authed({ pushTransport: fakeTransport().transport });
        for (const [method, route] of [
            ["GET", KEY],
            ["PUT", SUB],
            ["DELETE", SUB],
        ] as const) {
            const res = await s.app.request(route, {
                method,
                ...(method === "GET"
                    ? {}
                    : {
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({ subscription: subscription() }),
                      }),
            });
            expect(res.status, `${method} ${route}`).toBe(400);
            expect(await res.json(), `${method} ${route}`).toEqual({ error: "No auth header" });
        }
        expect(() => readFileSync(path.join(s.savePath, "server", "push_subscriptions.json"))).toThrow();
    });

    it("keeps auth, body-cap, and rate-limit rejections no-store on every push route", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
            // Three auth failures and two body-cap failures fill the same fixed limiter window.
            const s = await authed({ pushTransport: fakeTransport().transport, routeLimits: { requestsPerMinute: 5 } });
            const routes = [
                ["GET", KEY],
                ["PUT", SUB],
                ["DELETE", SUB],
            ] as const;
            for (const [method, route] of routes) {
                const res = await s.app.request(route, { method, headers: { "risu-auth": "not-a-jwt" } });
                expect(res.status, `${method} ${route}`).toBe(400);
                expect.soft(res.headers.get("cache-control"), `${method} ${route} auth`).toBe("no-store");
            }
            const oversized = JSON.stringify({ pad: "x".repeat(20 * 1024) });
            for (const method of ["PUT", "DELETE"]) {
                const res = await s.request(method, SUB, oversized, {
                    "content-length": String(Buffer.byteLength(oversized)),
                });
                expect(res.status, method).toBe(413);
                expect.soft(res.headers.get("cache-control"), `${method} ${SUB} body cap`).toBe("no-store");
            }
            for (const [method, route] of routes) {
                const res = await s.request(method, route);
                expect(res.status, `${method} ${route}`).toBe(429);
                expect.soft(res.headers.get("cache-control"), `${method} ${route} rate limit`).toBe("no-store");
            }
        } finally {
            vi.useRealTimers();
        }
    });

    it("refuses an invalid subscription, a non-object body, a non-string endpoint, and malformed JSON with 400", async () => {
        const s = await authed({ pushTransport: fakeTransport().transport });
        for (const body of [
            {},
            { subscription: null },
            { subscription: subscription("https://evil.example.com/x") },
            { subscription: { ...subscription(), keys: { p256dh: "x", auth: "y" } } },
            [subscription()],
        ]) {
            const res = await s.request("PUT", SUB, body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
            expect(await res.json()).toEqual({ error: "Invalid push subscription" });
        }
        const malformed = await s.request("PUT", SUB, "{ nope");
        expect(malformed.status).toBe(400);
        for (const body of [{}, { endpoint: 1 }, [1]]) {
            const res = await s.request("DELETE", SUB, body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(await res.json()).toEqual({ error: "endpoint must be a string" });
        }
    });

    it("answers 400, not 500, when the PUT body stream fails without a declared length", async () => {
        const s = await authed({ pushTransport: fakeTransport().transport });
        const res = await s.app.request(SUB, {
            method: "PUT",
            headers: await s.headers({ "content-type": "application/json" }),
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('{"subscription":'));
                    controller.error(new DOMException("The client went away", "AbortError"));
                },
            }),
            duplex: "half",
        } as RequestInit);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "Invalid JSON body" });
    });

    it("caps the subscription bodies at 16 KiB on the route itself", async () => {
        const s = await authed({ pushTransport: fakeTransport().transport });
        const big = { subscription: subscription(), pad: "x".repeat(20 * 1024) };
        for (const method of ["PUT", "DELETE"]) {
            const res = await s.request(method, SUB, big);
            expect(res.status, method).toBe(413);
            expect(await res.json(), method).toEqual({ error: "Request body too large" });
        }
        const fits = await s.request("PUT", SUB, { subscription: subscription(), pad: "x".repeat(8 * 1024) });
        expect(fits.status).toBe(204);
    });

    it("answers 500 when the file cannot be written, for a registration (nothing stored) and a removal (still registered)", async () => {
        const { calls, transport } = fakeTransport();
        const s = await authed({ pushTransport: transport });
        const file = path.join(s.savePath, "server", "push_subscriptions.json");
        const kept = subscription();
        expect((await s.request("PUT", SUB, { subscription: kept })).status).toBe(204);
        rmSync(file);
        mkdirSync(file);
        const put = await s.request("PUT", SUB, { subscription: subscription() });
        expect(put.status).toBe(500);
        expect(put.headers.get("cache-control")).toBe("no-store");
        expect(await put.json()).toEqual({ error: "The subscription could not be saved" });
        const del = await s.request("DELETE", SUB, { endpoint: kept.endpoint });
        expect(del.status).toBe(500);
        expect(await del.json()).toEqual({ error: "The removal could not be saved" });
        await s.context.push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint)).toEqual([kept.endpoint]);
        // Writable again: both land.
        rmSync(file, { recursive: true });
        expect((await s.request("DELETE", SUB, { endpoint: kept.endpoint })).status).toBe(204);
        expect(readJson(file).subscriptions).toEqual([]);
        expect((await s.request("PUT", SUB, { subscription: subscription() })).status).toBe(204);
        expect(readJson(file).subscriptions).toHaveLength(1);
    });

    it("answers null and 503 while push is off on the server", async () => {
        vi.stubEnv("RISU_WEB_PUSH_VAPID_PUBLIC_KEY", "lonely");
        vi.stubEnv("RISU_WEB_PUSH_VAPID_PRIVATE_KEY", "");
        const s = await authed({ pushTransport: fakeTransport().transport });
        expect(await (await s.request("GET", KEY)).json()).toEqual({ publicKey: null });
        const put = await s.request("PUT", SUB, { subscription: subscription() });
        expect(put.status).toBe(503);
        expect(await put.json()).toEqual({ error: "Push notifications are off on this server" });
        expect((await s.request("DELETE", SUB, { endpoint: "https://fcm.googleapis.com/fcm/send/x" })).status).toBe(
            204,
        );
        expect(() => readFileSync(path.join(s.savePath, "server", "web_push_vapid.json"))).toThrow();
    });

    it("a restart keeps the key and the subscriptions", async () => {
        const first = await authed({ pushTransport: fakeTransport().transport });
        const key = (await (await first.request("GET", KEY)).json()) as { publicKey: string };
        const sub = subscription();
        expect((await first.request("PUT", SUB, { subscription: sub })).status).toBe(204);
        await first.context.dispose();
        const { calls, transport } = fakeTransport();
        const second = createTestServer({ rootDir: first.rootDir, pushTransport: transport });
        try {
            expect(second.context.push.publicKey()).toBe(key.publicKey);
            await second.context.push.send(NOTIFICATION);
            expect(calls.map((call) => call.subscription.endpoint)).toEqual([sub.endpoint]);
        } finally {
            await second.context.dispose();
        }
    });
});

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

describe("serialized push persistence", () => {
    it("keeps concurrent registrations, acknowledges only durable writes, and refuses a failed PUT without installing it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const save = savePath();
        const entered = deferred<void>();
        const release = deferred<void>();
        let held = false;
        let fail = false;
        const fs: DurableFs = {
            ...promises,
            async open(file, flags, mode) {
                const handle = await promises.open(file, flags, mode);
                const sync = handle.sync.bind(handle);
                Object.assign(handle, {
                    sync: async () => {
                        if (flags === "r" && !held) {
                            held = true;
                            entered.resolve();
                            await release.promise;
                        }
                        if (flags === "wx" && fail) throw Object.assign(new Error("disk failure"), { code: "EIO" });
                        await sync();
                    },
                });
                return handle;
            },
        };
        const { calls, transport } = fakeTransport();
        const push = createPushService({ savePath: save, env: {}, fs, transport, now: () => 1_900_000_000_000 });
        const app = new Hono<AppEnv>();
        registerPushRoutes(app, {
            push,
            auth: createAuthStore(save, { bypass: true }),
            limiter: async (_c, next) => {
                await next();
            },
        });
        const put = (sub: unknown) =>
            app.request("/api/push/subscription", { ...json({ subscription: sub }), method: "PUT" });
        const first = subscription();
        const second = subscription();
        let answered = false;
        const a = Promise.resolve(put(first)).then((response) => {
            answered = true;
            return response;
        });
        await entered.promise;
        const b = put(second);
        try {
            await vi.advanceTimersByTimeAsync(0);
            expect(answered).toBe(false);
            await push.send(NOTIFICATION);
            expect(calls).toEqual([]);
            release.resolve();
            expect((await a).status).toBe(204);
            expect((await b).status).toBe(204);
            const file = serverFile(save, "push_subscriptions.json");
            expect(readJson(file).subscriptions).toEqual([
                { ...second, failureCount: 0, updatedAt: 1_900_000_000_000 },
                { ...first, failureCount: 0, updatedAt: 1_900_000_000_000 },
            ]);
            const durable = readFileSync(file, "utf8");
            fail = true;
            const refused = await put(subscription());
            expect(refused.status).toBe(500);
            expect(await refused.json()).toEqual({ error: "The subscription could not be saved" });
            expect(readFileSync(file, "utf8")).toBe(durable);
            await push.send(NOTIFICATION);
            expect(calls.map((call) => call.subscription.endpoint)).toEqual([second.endpoint, first.endpoint]);
        } finally {
            release.resolve();
            await Promise.all([a, b]);
            await push.drain();
            push.close();
            vi.useRealTimers();
        }
    });

    it("coalesces a settled delivery batch into one durable write without delaying send", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const save = savePath();
        createPushService({ savePath: save, env: {}, transport: fakeTransport().transport }).close();
        const subs = [subscription(), subscription(), subscription()];
        const file = serverFile(save, "push_subscriptions.json");
        writeFileSync(
            file,
            JSON.stringify({
                version: 1,
                subscriptions: subs.map((sub) => ({ ...sub, failureCount: 0, updatedAt: 10 })),
            }),
        );
        const deliveries = subs.map(() => deferred<never>());
        const allStarted = deferred<void>();
        let started = 0;
        const transport: PushTransport = {
            sendNotification: ((sub: { endpoint: string }) => {
                if (++started === 3) allStarted.resolve();
                return deliveries[subs.findIndex((entry) => entry.endpoint === sub.endpoint)].promise;
            }) as PushTransport["sendNotification"],
        };
        const entered = deferred<void>();
        const release = deferred<void>();
        const { fs, rename } = countedFs();
        fs.open = async (file, flags, mode) => {
            const handle = await promises.open(file, flags, mode);
            const sync = handle.sync.bind(handle);
            if (flags === "wx")
                Object.assign(handle, {
                    sync: async () => {
                        entered.resolve();
                        await release.promise;
                        await sync();
                    },
                });
            return handle;
        };
        const push = createPushService({ savePath: save, env: {}, fs, transport });
        let answered = false;
        const sending = push.send(NOTIFICATION).then(() => {
            answered = true;
        });
        await allStarted.promise;
        deliveries.forEach((delivery, index) => delivery.reject(httpError([500, 410, 503][index])));
        try {
            await entered.promise;
            await vi.advanceTimersByTimeAsync(0);
            expect(answered).toBe(true);
            expect(readJson(file).subscriptions).toHaveLength(3);
            release.resolve();
            await sending;
            await push.drain();
            expect(rename).toHaveBeenCalledOnce();
            expect(readJson(file).subscriptions).toEqual([
                { ...subs[0], failureCount: 1, lastError: "HTTP 500", updatedAt: 10 },
                { ...subs[2], failureCount: 1, lastError: "HTTP 503", updatedAt: 10 },
            ]);
        } finally {
            release.resolve();
            await sending;
            await push.drain();
            push.close();
            vi.useRealTimers();
        }
    });

    it("applies already-settled outcomes before a registration's skip check and 50-entry cap", async () => {
        for (const capped of [false, true]) {
            const save = savePath();
            createPushService({ savePath: save, env: {}, transport: fakeTransport().transport }).close();
            const template = subscription();
            const subs = Array.from({ length: capped ? 50 : 2 }, (_, index) => ({
                ...template,
                endpoint: `${ALLOWED}pending-${index}`,
            }));
            const file = serverFile(save, "push_subscriptions.json");
            writeFileSync(
                file,
                JSON.stringify({
                    version: 1,
                    subscriptions: subs.map((sub, index) => ({ ...sub, failureCount: 0, updatedAt: 100 - index })),
                }),
            );
            const firstOutcome = deferred<never>();
            const remaining = deferred<Awaited<ReturnType<PushTransport["sendNotification"]>>>();
            const settled = deferred<void>();
            const transport: PushTransport = {
                sendNotification: ((sub: { endpoint: string }) =>
                    sub.endpoint === subs[0].endpoint
                        ? firstOutcome.promise
                        : remaining.promise) as PushTransport["sendNotification"],
            };
            const { fs, rename } = countedFs();
            const push = createPushService({
                savePath: save,
                env: {},
                fs,
                transport,
                now: () => 101,
                diagnostics: {
                    record(event) {
                        if (event.phase === "failed" || event.phase === "removed") settled.resolve();
                    },
                },
            });
            const sending = push.send(NOTIFICATION);
            firstOutcome.reject(httpError(capped ? 410 : 500));
            await settled.promise;
            try {
                const incoming = capped ? { ...template, endpoint: `${ALLOWED}new` } : subs[0];
                expect(await push.register(incoming)).toBe("ok");
                expect(rename).toHaveBeenCalledOnce();
                expect(readJson(file).subscriptions).toEqual([
                    { ...incoming, failureCount: 0, updatedAt: 101 },
                    ...subs.slice(1).map((sub, index) => ({ ...sub, failureCount: 0, updatedAt: 99 - index })),
                ]);
            } finally {
                remaining.resolve({ statusCode: 201, body: "", headers: {} });
                await sending;
                await push.drain();
                push.close();
            }
        }
    });
});
