// @vitest-environment node
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import webPush from "web-push";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CompletionNotification } from "../../../shared/notifications.ts";
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
// the subscription, other failures counted with a sanitized label, a success clearing them, the
// sends one at a time with a bounded queue, `close`, never a rejection), and the routes
// (authenticated before the body, `no-store`, 400/503, the 16 KiB cap that the global limiter leaves
// to the route, DELETE idempotent). The `it.fails` cases pin intended behavior the implementation
// does not meet yet: they turn green once fixed.

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

    it("turn push off for one variable alone, an invalid environment pair, or an unreadable file, which is never replaced", () => {
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
            expect(service.upsert(subscription()), JSON.stringify(env)).toBe(false);
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
    function service(env: NodeJS.ProcessEnv = {}, answer?: (call: Call) => unknown) {
        const save = savePath();
        const fake = fakeTransport(answer);
        return { save, ...fake, service: createPushService({ savePath: save, env, transport: fake.transport }) };
    }

    it("accept a browser's subscription for an allowed push service and store it in save/server/push_subscriptions.json", () => {
        const { save, service: push } = service();
        const sub = subscription("https://web.push.apple.com/QWxs", { expirationTime: 1_900_000_000_000 });
        expect(push.upsert(sub)).toBe(true);
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
        expect(push.upsert(renewed)).toBe(true);
        expect(readJson(serverFile(save, "push_subscriptions.json")).subscriptions).toEqual([
            expect.objectContaining({ endpoint: sub.endpoint, keys: renewed.keys }),
        ]);
    });

    it("accept every default push host, the subdomain patterns, and RISU_WEB_PUSH_ALLOWED_HOSTS", () => {
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
            expect(push.upsert(subscription(endpoint)), endpoint).toBe(true);
        }
    });

    it("refuse endpoints outside the allowed hosts, other schemes, ports, credentials, fragments, and oversized ones", () => {
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
            expect(push.upsert(subscription(endpoint)), endpoint).toBe(false);
        }
        expect(() => readFileSync(serverFile(save, "push_subscriptions.json"))).toThrow();
    });

    it("refuse malformed shapes and keys: a missing or non-P-256 p256dh, an auth secret of another size, a bad expirationTime", () => {
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
            expect(push.upsert(raw), `case ${index}`).toBe(false);
        }
        expect(push.upsert({ ...ok, expirationTime: undefined })).toBe(true);
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

    it("registering one past the cap drops the least recently registered", () => {
        const { save, service: push } = service();
        const subs = Array.from({ length: MAX_PUSH_SUBSCRIPTIONS + 1 }, () => subscription());
        for (const [i, sub] of subs.entries()) {
            vi.setSystemTime(1_700_000_000_000 + i * 1000);
            expect(push.upsert(sub)).toBe(true);
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
        push.remove("https://fcm.googleapis.com/fcm/send/none");
        push.remove(42);
        await push.send(NOTIFICATION);
        expect(calls).toHaveLength(0);
        const sub = subscription();
        expect(push.upsert(sub)).toBe(true);
        push.remove(sub.endpoint);
        expect(readJson(serverFile(save, "push_subscriptions.json")).subscriptions).toEqual([]);
    });

    // `new URL()` decodes `%2e` in the host (`127.0.0.1.notify.windows.com` passes the allowlist)
    // while `web-push` posts with the legacy `url.parse()`, whose hostname of the same string is
    // `127.0.0.1`; a host character the WHATWG parser keeps (`'`, `"`, `;`, a backtick, `{`, `}`)
    // ends the host for `url.parse` the same way. Only a plain DNS name is allowed.
    it("refuses a host spelled with escapes or punctuation that the transport's URL parser would read differently", () => {
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
                expect(push.upsert(subscription(endpoint)), endpoint).toBe(false);
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
            expect(push.upsert(subscription(endpoint)), JSON.stringify(endpoint)).toBe(false);
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
            expect(push.upsert(subscription(spelling)), spelling).toBe(true);
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
        expect(push.remove("https://FCM.googleapis.com:443/fcm/send/ABC")).toBe(true);
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
        expect(push.upsert({ ...ok, keys: { ...ok.keys, p256dh: offCurve } })).toBe(false);
        const padded = { ...ok, keys: { p256dh: ok.keys.p256dh + "=", auth: ok.keys.auth + "==" } };
        expect(push.upsert(padded)).toBe(true);
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
        expect(push.register(kept)).toBe("ok");
        // The file's place is taken by a directory: the rename of the temporary file fails.
        rmSync(file);
        mkdirSync(file);
        expect(push.register(subscription())).toBe("unsaved");
        expect(push.upsert(subscription())).toBe(false);
        expect(push.remove(kept.endpoint)).toBe(false);
        await push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint)).toEqual([kept.endpoint]);
        expect(push.register("junk")).toBe("invalid");
        const off = createPushService({
            savePath: savePath(),
            env: { RISU_WEB_PUSH_VAPID_PUBLIC_KEY: "lonely" },
            transport: fakeTransport().transport,
        });
        expect(off.register(subscription())).toBe("disabled");
    });

    it("a removal after a 404/410 whose bookkeeping write failed still writes the file (the disk may hold the entry)", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        let answer: unknown;
        const { transport } = fakeTransport(() => answer);
        const push = createPushService({ savePath: save, env: {}, transport });
        const gone = subscription();
        expect(push.register(gone)).toBe("ok");
        rmSync(file);
        mkdirSync(file);
        answer = httpError(410);
        await push.send(NOTIFICATION);
        // Memory dropped it, the file (a directory for now) still holds it as far as the service knows.
        rmSync(file, { recursive: true });
        expect(push.remove(gone.endpoint)).toBe(true);
        expect(readJson(file)).toEqual({ version: 1, subscriptions: [] });
        // Nothing uncertain any more: removing an unknown endpoint writes nothing.
        rmSync(file);
        expect(push.remove("https://fcm.googleapis.com/fcm/send/unknown")).toBe(true);
        expect(() => readFileSync(file)).toThrow();
    });

    it("a removal racing a delivery that just dropped the endpoint (410) writes the file", async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let seen!: () => void;
        const dropped = new Promise<void>((resolve) => {
            seen = resolve;
        });
        const gone = subscription();
        const slow = subscription();
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        const transport: PushTransport = {
            sendNotification: vi.fn(async (sub: { endpoint: string }) => {
                if (sub.endpoint === gone.endpoint) {
                    queueMicrotask(seen);
                    throw httpError(410);
                }
                await gate;
                return { statusCode: 201, body: "", headers: {} };
            }) as unknown as PushTransport["sendNotification"],
        };
        const push = createPushService({ savePath: save, env: {}, transport });
        push.register(gone);
        push.register(slow);
        const sending = push.send(NOTIFICATION);
        await dropped;
        await new Promise((resolve) => setTimeout(resolve, 5));
        // Memory lacks `gone` now, the file still has it until the bookkeeping write after the send.
        expect(push.remove(gone.endpoint)).toBe(true);
        expect(readJson(file).subscriptions.map((row: { endpoint: string }) => row.endpoint)).toEqual([slow.endpoint]);
        release();
        await sending;
        expect(readJson(file).subscriptions.map((row: { endpoint: string }) => row.endpoint)).toEqual([slow.endpoint]);
    });

    it("a file that cannot be read is never overwritten: registrations and removals fail until it can, then keep its entries", async () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        const { calls, transport } = fakeTransport();
        // A directory in the file's place exists but cannot be read as a file.
        mkdirSync(file, { recursive: true });
        const push = createPushService({ savePath: save, env: {}, transport });
        expect(push.register(subscription())).toBe("unsaved");
        expect(push.remove("https://fcm.googleapis.com/fcm/send/x")).toBe(false);
        await push.send(NOTIFICATION);
        expect(calls).toHaveLength(0);
        // Readable again, with an entry of its own: the next operation loads it and keeps it.
        rmSync(file, { recursive: true });
        const existing = subscription();
        writeFileSync(file, JSON.stringify({ version: 1, subscriptions: [{ ...existing, updatedAt: 5 }] }));
        const added = subscription();
        expect(push.register(added)).toBe("ok");
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

    it("a file that is not JSON starts empty and is replaced by the first write, also a removal", () => {
        const save = savePath();
        const file = serverFile(save, "push_subscriptions.json");
        mkdirSync(path.join(save, "server"), { recursive: true });
        writeFileSync(file, "{{{");
        const push = createPushService({ savePath: save, env: {}, transport: fakeTransport().transport });
        expect(push.remove("https://fcm.googleapis.com/fcm/send/unknown")).toBe(true);
        expect(readJson(file)).toEqual({ version: 1, subscriptions: [] });
        const sub = subscription();
        expect(push.register(sub)).toBe("ok");
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

    it("sends the serialized notification to every subscription with the TTL, urgency, topic, timeout, and per-call VAPID details", async () => {
        const { push, calls, save } = delivering();
        const a = subscription();
        const b = subscription("https://updates.push.services.mozilla.com/wpush/v2/b");
        push.upsert(a);
        push.upsert(b);
        await push.send(NOTIFICATION);
        expect(calls.map((call) => call.subscription.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
        const keys = readJson(serverFile(save, "web_push_vapid.json"));
        for (const call of calls) {
            expect(JSON.parse(call.payload)).toEqual(NOTIFICATION);
            expect(call.subscription.keys).toEqual((call.subscription.endpoint === a.endpoint ? a : b).keys);
            expect(call.options).toEqual({
                TTL: 3600,
                urgency: "normal",
                topic: "chat-completion",
                timeout: 10_000,
                vapidDetails: {
                    subject: "mailto:ops@example.com",
                    publicKey: keys.publicKey,
                    privateKey: keys.privateKey,
                },
            });
        }
    });

    it("removes a subscription the push service reports gone (404, 410), counts other failures with a sanitized label, and clears them on success", async () => {
        let failures: Record<string, unknown> = {};
        const { push, calls, file } = delivering((call) => failures[call.subscription.endpoint]);
        const gone = subscription();
        const missing = subscription();
        const flaky = subscription();
        const offline = subscription();
        for (const sub of [gone, missing, flaky, offline]) {
            push.upsert(sub);
        }
        failures = {
            [gone.endpoint]: httpError(410),
            [missing.endpoint]: httpError(404),
            [flaky.endpoint]: httpError(500),
            [offline.endpoint]: new Error("ECONNRESET https://secret.example/token"),
        };
        await push.send(NOTIFICATION);
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
        push.upsert(sub);
        const sending = push.send(NOTIFICATION);
        await started;
        // The browser registered again with new keys while the old send is in flight.
        const renewed = { ...sub, keys: subscription().keys };
        push.upsert(renewed);
        release();
        await sending;
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
        push.upsert(subscription());
        const sends = Array.from({ length: 8 }, (_, i) => push.send({ ...NOTIFICATION, body: `n${i}` }));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(started).toEqual(["n0"]);
        while (gates.length > 0 || started.length < 4) {
            gates.shift()?.();
            await new Promise((resolve) => setTimeout(resolve, 5));
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
        throwing.upsert(subscription());
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
