// Probes direct asset delivery through a signing service worker and the browser HTTP cache.
// Runs its own localhost server, with real IndexedDB CryptoKeys, ES256 verification, protected
// images/SVG/video, and opaque srcdoc frames. No app server, Cache Storage, or request routing
// is involved: only this server's request log determines whether bytes reached the network.
// Each check has a fresh context; cache-dependent loads keep that context and their asset URL.
//
// Env: PROBE_BROWSERS (comma-separated chromium,firefox; default both), DEBUG (server/worker logs).
// Chromium uses chromePath from stack.mjs (RISU_CHROME or /usr/bin/google-chrome); Firefox uses
// Playwright's installed build. An unavailable Firefox is skipped. Video needs /usr/bin/ffmpeg.
// Failures describe observed mechanics and make the exit code nonzero, including timeouts and
// page errors. A blocked SVG navigation may reach the server and receive 401; the table says so.
// Losing worker control across navigation is reported separately from an HTTP cache miss.
// If the primary cache measurement loses control, a fresh context repeats it with a worker that
// answers navigation requests using fetch(event.request). This keeps the cache mechanic measurable
// separately from the fallthrough navigation's control precondition; a control failure still fails
// the run even when cache reuse succeeds with navigations answered.
// Video responses are capped at 64 KiB and paced so a far seek needs uncached bytes. The server's
// request index marks the seek boundary; a signed nonzero Range answered 206 after it is required.
//
// Usage: node util/playwright/probeDirectAssets.mjs
import { execFile } from "node:child_process";
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, firefox } from "playwright-core";
import { chromePath } from "./stack.mjs";

const BROWSERS = [
    ...new Set(
        (process.env.PROBE_BROWSERS ?? "chromium,firefox")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    ),
];
const DEBUG = Boolean(process.env.DEBUG);
const TIMEOUT = 15_000;
const nonce = randomUUID();
const knownPayload = `indexeddb-signature:${nonce}`;
const csp = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
    "base64",
);
const assets = new Map();
const publicKeys = new Map();
const requests = [];
const serverErrors = [];
const results = [];
let base;
let workDir;
let browser;
let video;
let videoError;

async function bounded(promise, label, ms = TIMEOUT) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms} ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

// Both realms open the same store; the CryptoKeyPair itself is structured-cloned into IndexedDB.
function openKeyDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("direct-assets-probe", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("keys");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("key database blocked"));
    });
}

function workerProgram() {
    const log = [];
    const answerNavigations = new URL(self.location.href).searchParams.get("navigate") === "answered";
    const destinations = new Set(["image", "audio", "video", "track", "style", "font"]);
    self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
    self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
    const encode = (bytes) =>
        btoa(String.fromCharCode(...new Uint8Array(bytes)))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replace(/=+$/, "");
    const json = (value) => encode(new TextEncoder().encode(JSON.stringify(value)));

    async function sign(payload, inspect = false) {
        const db = await openKeyDatabase();
        let pair, kid;
        try {
            await new Promise((resolve, reject) => {
                const tx = db.transaction("keys");
                const store = tx.objectStore("keys");
                store.get("pair").onsuccess = (event) => {
                    pair = event.target.result;
                };
                store.get("kid").onsuccess = (event) => {
                    kid = event.target.result;
                };
                tx.oncomplete = resolve;
                tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("key read failed"));
            });
        } finally {
            db.close();
        }
        if (!pair?.privateKey || !kid) throw new Error("no stored signing pair");
        let exportRejected = false;
        if (inspect) {
            try {
                await crypto.subtle.exportKey("jwk", pair.privateKey);
            } catch (error) {
                if (error.name !== "InvalidAccessError") throw error;
                exportRejected = true;
            }
        }
        const input = `${json({ alg: "ES256", typ: "JWT", kid })}.${json({ payload, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID() })}`;
        const signature = await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            pair.privateKey,
            new TextEncoder().encode(input),
        );
        return {
            token: `${input}.${encode(signature)}`,
            nonExtractable: pair.privateKey.extractable === false,
            exportRejected,
            signatureBytes: signature.byteLength,
        };
    }

    self.addEventListener("fetch", (event) => {
        const request = event.request;
        const url = new URL(request.url);
        const intercepted =
            ["GET", "HEAD"].includes(request.method) &&
            url.origin === self.location.origin &&
            url.pathname.startsWith("/asset/") &&
            destinations.has(request.destination) &&
            Boolean(event.clientId);
        const entry = {
            url: request.url,
            method: request.method,
            destination: request.destination,
            mode: request.mode,
            clientId: event.clientId,
            intercepted,
            range: request.headers.get("range"),
        };
        log.push(entry);
        if (!intercepted) {
            if (answerNavigations && request.mode === "navigate") {
                entry.navigationAnswered = true;
                event.respondWith(fetch(event.request));
            }
            return;
        }
        event.respondWith(
            (async () => {
                try {
                    const { token } = await sign(url.pathname);
                    const headers = { "x-probe-auth": token };
                    if (entry.range) headers.range = entry.range;
                    // Constructing a request removes the original no-cors header guard.
                    const response = await fetch(url.href, {
                        method: request.method,
                        headers,
                        mode: "same-origin",
                        credentials: "omit",
                        cache: "default",
                    });
                    entry.status = response.status;
                    return response;
                } catch (error) {
                    entry.error = String(error);
                    return new Response(String(error), { status: 500, headers: { "Cache-Control": "no-store" } });
                }
            })(),
        );
    });
    self.addEventListener("message", (event) => {
        event.waitUntil(
            (async () => {
                try {
                    const value =
                        event.data.type === "sign"
                            ? await sign(event.data.payload, true)
                            : log.map((entry) => ({ ...entry }));
                    event.ports[0].postMessage({ value });
                } catch (error) {
                    event.ports[0].postMessage({ error: String(error) });
                }
            })(),
        );
    });
}

function pageProgram() {
    const timeout = (promise, label, ms = 12_000) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms} ms`)), ms);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            );
        });
    const worker = (type, payload) =>
        timeout(
            (async () => {
                // The active registration can still expose diagnostics if a navigation lost control.
                const target =
                    navigator.serviceWorker.controller ??
                    (type === "log" ? (await navigator.serviceWorker.ready).active : null);
                if (!target) throw new Error("no worker controller");
                return await new Promise((resolve, reject) => {
                    const channel = new MessageChannel();
                    channel.port1.onmessage = ({ data }) => {
                        channel.port1.close();
                        if (data.error) reject(new Error(data.error));
                        else resolve(data.value);
                    };
                    target.postMessage({ type, payload }, [channel.port2]);
                });
            })(),
            `worker ${type}`,
        );
    const image = (url) =>
        timeout(
            new Promise((resolve) => {
                const img = document.createElement("img");
                img.onload = img.onerror = (event) => resolve({ event: event.type, width: img.naturalWidth });
                img.src = url;
                document.body.append(img);
            }),
            "image load",
        );
    const frameImage = (url) =>
        timeout(
            new Promise((resolve) => {
                const frame = document.createElement("iframe");
                const id = crypto.randomUUID();
                frame.sandbox = "allow-scripts";
                const listener = (event) => {
                    if (event.source !== frame.contentWindow || event.data?.id !== id) return;
                    removeEventListener("message", listener);
                    resolve({ ...event.data, origin: event.origin });
                };
                addEventListener("message", listener);
                frame.srcdoc = `<body><script>const img = new Image(); img.onload = img.onerror = (event) => parent.postMessage({id: ${JSON.stringify(id)}, event: event.type, width: img.naturalWidth}, '*'); img.src = ${JSON.stringify(url)}; document.body.append(img);<\/script></body>`;
                document.body.append(frame);
            }),
            "opaque iframe image",
        );

    window.probe = {
        worker,
        image,
        frameImage,
        ready: timeout(
            (async () => {
                if (!isSecureContext) throw new Error("localhost is not a secure context");
                const kid = new URL(location.href).searchParams.get("key");
                const db = await openKeyDatabase();
                let pair;
                try {
                    pair = await new Promise((resolve, reject) => {
                        const request = db.transaction("keys").objectStore("keys").get("pair");
                        request.onsuccess = () => resolve(request.result);
                        request.onerror = () => reject(request.error);
                    });
                    if (!pair) {
                        pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
                            "sign",
                            "verify",
                        ]);
                        await new Promise((resolve, reject) => {
                            const tx = db.transaction("keys", "readwrite");
                            tx.objectStore("keys").put(pair, "pair");
                            tx.objectStore("keys").put(kid, "kid");
                            tx.oncomplete = resolve;
                            tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("key write failed"));
                        });
                    }
                } finally {
                    db.close();
                }
                let exportRejected = false;
                try {
                    await crypto.subtle.exportKey("jwk", pair.privateKey);
                } catch (error) {
                    if (error.name !== "InvalidAccessError") throw error;
                    exportRejected = true;
                }
                const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
                const registered = await fetch(`/register/${kid}`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(publicJwk),
                    signal: AbortSignal.timeout(10_000),
                });
                if (!registered.ok) throw new Error(`key registration: ${registered.status}`);
                const workerUrl =
                    new URL(location.href).searchParams.get("navigate") === "answered"
                        ? "/worker.js?navigate=answered"
                        : "/worker.js";
                await navigator.serviceWorker.register(workerUrl, { scope: "/" });
                await navigator.serviceWorker.ready;
                if (!navigator.serviceWorker.controller) {
                    await timeout(
                        new Promise((resolve) => {
                            navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
                            if (navigator.serviceWorker.controller) resolve();
                        }),
                        "worker control",
                        4_000,
                    ).catch(() => {});
                }
                return {
                    controlled: Boolean(navigator.serviceWorker.controller),
                    secure: isSecureContext,
                    nonExtractable: pair.privateKey.extractable === false,
                    exportRejected,
                };
            })(),
            "page initialization",
        ),
    };
    // Node awaits this promise explicitly; suppress an early unhandled rejection while it attaches.
    window.probe.ready.catch(() => {});
}

const workerSource = `${openKeyDatabase.toString()}\n(${workerProgram.toString()})();`;
const pageSource = `<!doctype html><html><head><link rel="icon" href="data:,"><title>Direct asset probe</title></head><body><script>${openKeyDatabase.toString()}\n(${pageProgram.toString()})();</script></body></html>`;

function validToken(token, payload) {
    if (typeof token !== "string") return false;
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return false;
        const header = JSON.parse(Buffer.from(parts[0], "base64url"));
        const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
        const key = publicKeys.get(header.kid);
        return (
            header.alg === "ES256" &&
            header.typ === "JWT" &&
            claims.payload === payload &&
            Boolean(key) &&
            verify(
                "sha256",
                Buffer.from(`${parts[0]}.${parts[1]}`),
                { key, dsaEncoding: "ieee-p1363" },
                Buffer.from(parts[2], "base64url"),
            )
        );
    } catch {
        return false;
    }
}

async function handleRequest(req, res) {
    const url = new URL(req.url, base);
    const token = req.headers["x-probe-auth"];
    const entry = {
        method: req.method,
        path: url.pathname,
        auth: Boolean(token),
        valid: validToken(token, url.pathname === "/verify" ? knownPayload : url.pathname),
        range: req.headers.range ?? null,
        destination: req.headers["sec-fetch-dest"] ?? null,
        mode: req.headers["sec-fetch-mode"] ?? null,
    };
    requests.push(entry);
    res.on("finish", () => {
        if (DEBUG) console.log("server", JSON.stringify(entry));
    });
    function send(status, body, headers = {}, bodyDelayMs = 0) {
        entry.status = status;
        const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
        res.writeHead(status, {
            "Cache-Control": "no-store",
            "Content-Type": "text/plain; charset=utf-8",
            ...headers,
            "Content-Length": bytes.length,
        });
        const end = () => res.end(req.method === "HEAD" ? undefined : bytes);
        if (bodyDelayMs && req.method !== "HEAD") {
            res.flushHeaders();
            const timer = setTimeout(end, bodyDelayMs);
            res.once("close", () => clearTimeout(timer));
        } else {
            end();
        }
    }
    if (url.pathname.startsWith("/register/") && req.method === "POST") {
        let body = "";
        for await (const chunk of req) {
            body += chunk;
            if (body.length > 8192) throw new Error("oversized public JWK");
        }
        const jwk = JSON.parse(body);
        if (jwk.kty !== "EC" || jwk.crv !== "P-256" || jwk.d) throw new Error("expected a public P-256 JWK");
        publicKeys.set(url.pathname.slice("/register/".length), createPublicKey({ key: jwk, format: "jwk" }));
        send(200, "registered");
    } else if (url.pathname === "/verify") {
        send(entry.valid ? 200 : 401, JSON.stringify({ valid: entry.valid }), { "Content-Type": "application/json" });
    } else if (url.pathname === "/page") {
        send(200, pageSource, { "Content-Type": "text/html; charset=utf-8" });
    } else if (url.pathname === "/worker.js") {
        send(200, workerSource, { "Content-Type": "text/javascript; charset=utf-8", "Service-Worker-Allowed": "/" });
    } else if (assets.has(url.pathname)) {
        const asset = assets.get(url.pathname);
        const headers = {
            "Content-Type": asset.type,
            "X-Content-Type-Options": "nosniff",
            "Accept-Ranges": "bytes",
            ...(asset.corp === false ? {} : { "Cross-Origin-Resource-Policy": "same-origin" }),
            ...(asset.csp === false ? {} : { "Content-Security-Policy": csp }),
        };
        if (asset.auth !== false && !entry.valid) {
            send(401, "missing or invalid signature", headers);
            return;
        }
        headers["Cache-Control"] = "private, max-age=31536000, immutable";
        const bytes = asset.bytes;
        if (!entry.range) {
            send(200, bytes, headers);
            return;
        }
        const match = /^bytes=(\d*)-(\d*)$/.exec(entry.range);
        let start = match?.[1] ? Number(match[1]) : Math.max(0, bytes.length - Number(match?.[2]));
        let end = match?.[1] && match?.[2] ? Number(match[2]) : bytes.length - 1;
        if (
            !match ||
            (!match[1] && !match[2]) ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start >= bytes.length ||
            start > end ||
            (!match[1] && Number(match[2]) === 0)
        ) {
            send(416, "", { ...headers, "Content-Range": `bytes */${bytes.length}` });
            return;
        }
        end = Math.min(end, bytes.length - 1, start + (asset.rangeCap ?? bytes.length) - 1);
        entry.rangeStart = start;
        entry.rangeEnd = end;
        send(
            206,
            bytes.subarray(start, end + 1),
            {
                ...headers,
                "Content-Range": `bytes ${start}-${end}/${bytes.length}`,
            },
            asset.rangeDelayMs,
        );
    } else {
        send(404, "not found");
    }
}

const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
        serverErrors.push(String(error));
        console.error("server error:", error);
        if (!res.headersSent) res.writeHead(500, { "Cache-Control": "no-store" });
        res.end("probe server error");
    });
});
server.requestTimeout = TIMEOUT;
server.headersTimeout = TIMEOUT;

const assetRequests = (url) => requests.filter((entry) => entry.path === new URL(url).pathname);
const eventsFor = (log, url) => log.filter((entry) => entry.url === url);
const loaded = (image) => image.event === "load" && image.width > 0;
const statuses = (entries) => (entries.length ? entries.map((entry) => entry.status ?? "pending").join(",") : "none");
const signed = (entries) => entries.filter((entry) => entry.auth && entry.valid).length;
const outcome = (ok, reason) => ({ status: ok ? "PASS" : "FAIL", reason: reason.replaceAll("\n", " ") });

function addAsset(browserName, probe, extension, options = {}) {
    const assetPath = `/asset/${nonce}-${browserName}-${probe}-${randomUUID()}.${extension}`;
    assets.set(assetPath, { bytes: png, type: "image/png", ...options });
    return base + assetPath;
}

async function fixture(context, { answerNavigations = false } = {}) {
    const kid = randomUUID();
    let visit = 0;
    const pageErrors = [];
    context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(String(error))));
    context.setDefaultTimeout(TIMEOUT);
    context.setDefaultNavigationTimeout(TIMEOUT);
    const openPage = async (requireControl = true) => {
        const url = `${base}/page?key=${kid}&visit=${++visit}${answerNavigations ? "&navigate=answered" : ""}`;
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "load" });
        let state = await bounded(
            page.evaluate(() => window.probe.ready),
            "page ready",
        );
        if (!state.controlled && requireControl) {
            await page.reload({ waitUntil: "load" });
            state = await bounded(
                page.evaluate(() => window.probe.ready),
                "page ready after control reload",
            );
        }
        if (!state.controlled && requireControl) {
            const registrations = await page.evaluate(async () =>
                (await navigator.serviceWorker.getRegistrations()).map((registration) => ({
                    scope: registration.scope,
                    active: registration.active?.state,
                    waiting: registration.waiting?.state,
                    installing: registration.installing?.state,
                })),
            );
            throw new Error(`page still has no service worker controller: ${JSON.stringify(registrations)}`);
        }
        return { page, state };
    };
    const { page, state } = await openPage();
    const log = async (target = page) => {
        const entries = await bounded(
            target.evaluate(() => window.probe.worker("log")),
            "worker log",
        );
        if (DEBUG) console.log("worker", JSON.stringify(entries));
        if (entries.some((entry) => entry.error))
            throw new Error(`worker fetch error: ${JSON.stringify(entries.filter((entry) => entry.error))}`);
        return entries;
    };
    return { page, state, pageErrors, openPage, log };
}

async function probeKey(h) {
    const proof = await bounded(
        h.page.evaluate((payload) => window.probe.worker("sign", payload), knownPayload),
        "worker signature",
    );
    const verification = await bounded(
        h.page.evaluate(async (token) => {
            const response = await fetch("/verify", {
                headers: { "x-probe-auth": token },
                signal: AbortSignal.timeout(10_000),
            });
            return { status: response.status, ...(await response.json()) };
        }, proof.token),
        "server signature verification",
    );
    const privateSafe =
        h.state.nonExtractable && h.state.exportRejected && proof.nonExtractable && proof.exportRejected;
    return outcome(
        h.state.secure && privateSafe && verification.valid && verification.status === 200,
        `secure=${h.state.secure}; IDB worker signature=${verification.valid} (${proof.signatureBytes}B, HTTP ${verification.status}); private extractable=${!proof.nonExtractable}; export rejected page/worker=${h.state.exportRejected}/${proof.exportRejected}`,
    );
}

async function probeCache(h, name) {
    const url = addAsset(name, "b", "png");
    const first = await h.page.evaluate((url) => window.probe.image(url), url);
    const cold = assetRequests(url).length;
    const coldEvents = eventsFor(await h.log(), url);
    // Closing the old document avoids its decoded images; the new navigation is never reloaded.
    const { page, state } = await h.openPage(false);
    await h.page.close();
    state.controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    const second = await page.evaluate((url) => window.probe.image(url), url);
    const network = assetRequests(url);
    const warm = network.length - cold;
    const events = eventsFor(await h.log(page), url);
    const coldPassed =
        loaded(first) &&
        cold === 1 &&
        signed(network.slice(0, cold)) === 1 &&
        network[0].status === 200 &&
        coldEvents.length === 1 &&
        coldEvents[0].intercepted;
    const controlLossOnly =
        coldPassed &&
        !state.controlled &&
        events.length === coldEvents.length &&
        network.slice(cold).every((entry) => !entry.auth && entry.status === 401);
    return {
        ...outcome(
            state.controlled &&
                loaded(first) &&
                loaded(second) &&
                cold === 1 &&
                signed(network) === 1 &&
                network[0].status === 200 &&
                warm === 0 &&
                coldEvents.length === 1 &&
                events.length === 2 &&
                events.every((entry) => entry.intercepted),
            `controlled cold/warm=${h.state.controlled}/${state.controlled}; image widths=${first.width}/${second.width}; server cold/warm=${cold}/${warm}, signed=${signed(network)}, statuses=${statuses(network)}; worker images=${events.length}${state.controlled ? "" : "; warm document lost control: HTTP-cache reuse inconclusive"}`,
        ),
        controlLost: !state.controlled,
        controlLossOnly,
    };
}

async function probeCacheWithNavigation(name) {
    let context;
    let h;
    let result;
    try {
        context = await bounded(browser.newContext({ serviceWorkers: "allow" }), "cache variant context creation");
        result = await bounded(
            (async () => {
                h = await fixture(context, { answerNavigations: true });
                return await probeCache(h, name);
            })(),
            `${name} (b navigate answered)`,
            65_000,
        );
    } catch (error) {
        result = outcome(false, String(error));
        if (DEBUG) console.error(error);
    } finally {
        if (context) {
            try {
                await bounded(context.close(), "cache variant context cleanup");
            } catch (error) {
                result = outcome(false, `${result?.reason ?? ""}; context cleanup: ${String(error)}`);
            }
        }
    }
    if (h?.pageErrors.length) result = outcome(false, `${result.reason}; page errors: ${h.pageErrors.join("; ")}`);
    return result;
}

async function probeVideo(h, name) {
    if (videoError) return outcome(false, `ffmpeg: ${videoError}`);
    const url = addAsset(name, "c", "webm", {
        bytes: video,
        type: "video/webm",
        rangeCap: 64 * 1024,
        rangeDelayMs: 25,
    });
    let seekIndex;
    let playback;
    try {
        const initial = await bounded(
            h.page.evaluate(async (url) => {
                const video = document.createElement("video");
                video.muted = true;
                video.preload = "metadata";
                video.playsInline = true;
                document.body.append(video);
                const wait = (label, predicate, event) =>
                    new Promise((resolve, reject) => {
                        let timer, poll;
                        const cleanup = () => {
                            clearTimeout(timer);
                            clearInterval(poll);
                            video.removeEventListener("error", fail);
                            if (event) video.removeEventListener(event, check);
                        };
                        const check = () => {
                            if (predicate()) {
                                cleanup();
                                resolve();
                            }
                        };
                        const fail = () => {
                            cleanup();
                            reject(new Error(`${label}: media error ${video.error?.code} ${video.error?.message}`));
                        };
                        video.addEventListener("error", fail);
                        if (event) video.addEventListener(event, check);
                        timer = setTimeout(() => {
                            cleanup();
                            reject(new Error(`${label}: timeout`));
                        }, 12_000);
                        poll = setInterval(check, 50);
                        if (video.error) fail();
                        else check();
                    });
                const play = async () => {
                    let timer;
                    try {
                        await Promise.race([
                            video.play(),
                            new Promise((_, reject) => {
                                timer = setTimeout(() => reject(new Error("play(): timeout")), 12_000);
                            }),
                        ]);
                    } finally {
                        clearTimeout(timer);
                    }
                };
                window.__probeVideo = { video, wait, play };
                video.src = url;
                await wait("metadata", () => Number.isFinite(video.duration), "loadedmetadata");
                await play();
                await wait("playback advance", () => video.currentTime >= 0.25 && !video.paused, "timeupdate");
                const before = video.currentTime;
                const target = video.duration * 0.82;
                video.pause();
                const buffered = Array.from({ length: video.buffered.length }, (_, index) => [
                    video.buffered.start(index),
                    video.buffered.end(index),
                ]);
                return {
                    before,
                    target,
                    duration: video.duration,
                    buffered,
                    targetBuffered: buffered.some(([start, end]) => start <= target && target < end),
                };
            }, url),
            "video initial playback",
            35_000,
        );
        if (initial.targetBuffered) throw new Error(`seek target already buffered: ${JSON.stringify(initial)}`);
        // This boundary separates server requests received before the seek from those received after it.
        seekIndex = requests.length;
        playback = await bounded(
            h.page.evaluate(async (initial) => {
                const { video, wait, play } = window.__probeVideo;
                const target = initial.target;
                let seeked = false;
                video.addEventListener(
                    "seeked",
                    () => {
                        seeked = true;
                    },
                    { once: true },
                );
                video.currentTime = target;
                await wait(
                    "seeked",
                    () =>
                        seeked &&
                        !video.seeking &&
                        Math.abs(video.currentTime - target) < 0.75 &&
                        video.readyState >= 2,
                    "seeked",
                );
                const afterSeek = video.currentTime;
                await play();
                await wait(
                    "playback after seek",
                    () => video.currentTime >= afterSeek + 0.2 && video.readyState >= 2,
                    "timeupdate",
                );
                const result = {
                    ...initial,
                    target,
                    afterSeek,
                    continued: video.currentTime,
                    seeked,
                    duration: video.duration,
                    readyState: video.readyState,
                };
                return result;
            }, initial),
            "video seek and continued playback",
            25_000,
        );
    } catch (error) {
        playback = { error: String(error) };
    } finally {
        // Stop speculative buffering before counting the range requests for this playback.
        await bounded(
            h.page.evaluate(() => {
                const video = window.__probeVideo?.video;
                if (video) {
                    video.pause();
                    video.removeAttribute("src");
                    video.load();
                }
            }),
            "video cleanup",
        );
    }
    const network = assetRequests(url);
    const ranges = network.filter((entry) => entry.range);
    const path = new URL(url).pathname;
    const afterSeekRanges =
        seekIndex === undefined ? [] : requests.slice(seekIndex).filter((entry) => entry.path === path && entry.range);
    const beforeSeekRanges = ranges.length - afterSeekRanges.length;
    const signedPostSeek = afterSeekRanges.filter(
        (entry) => entry.rangeStart > 0 && entry.valid && entry.status === 206,
    );
    const statusCounts =
        [...new Set(ranges.map((entry) => entry.status))]
            .map((status) => `${status ?? "pending"}x${ranges.filter((entry) => entry.status === status).length}`)
            .join(",") || "none";
    const events = eventsFor(await h.log(), url);
    const ok =
        !playback.error &&
        ranges.length > 0 &&
        ranges.every((entry) => entry.valid && entry.status === 206) &&
        signedPostSeek.length > 0 &&
        events.length > 0 &&
        events.every((entry) => entry.intercepted && entry.destination === "video") &&
        playback.seeked &&
        playback.continued > playback.afterSeek &&
        playback.before > 0;
    return outcome(
        ok,
        `${video.length}B; signed ranges=${signed(ranges)}/${ranges.length}, statuses=${statusCounts}; ranges before/after seek=${beforeSeekRanges}/${afterSeekRanges.length}, first post-seek start=${afterSeekRanges[0]?.rangeStart ?? "none"}, signed nonzero post-seek 206=${signedPostSeek.length}, seek request index=${seekIndex ?? "not issued"}; worker video=${events.length}, modes=${[...new Set(events.map((entry) => entry.mode))].join(",")}; ${playback.error ? `playback failed: ${playback.error}` : `played=${playback.before.toFixed(2)}s, seek=${playback.afterSeek.toFixed(2)}/${playback.target.toFixed(2)}s, target buffered before=false, continued=${playback.continued.toFixed(2)}s, ready=${playback.readyState}`}`,
    );
}

function svg(marker) {
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/><script>console.log(${JSON.stringify(marker)}); document.documentElement.setAttribute('data-probe-script', ${JSON.stringify(marker)});</script></svg>`,
    );
}

async function probeSvg(h, name) {
    const marker = `protected-svg-${randomUUID()}`;
    const controlMarker = `control-svg-${randomUUID()}`;
    const url = addAsset(name, "d", "svg", { bytes: svg(marker), type: "image/svg+xml" });
    const control = addAsset(name, "d-control", "svg", {
        bytes: svg(controlMarker),
        type: "image/svg+xml",
        auth: false,
        csp: false,
    });
    const consoleMarkers = [];
    h.page.on("console", (message) => {
        if (message.text().includes(marker)) consoleMarkers.push(message.text());
    });
    const preload = await h.page.evaluate((url) => window.probe.image(url), url);
    const cold = assetRequests(url).length;
    const preEvents = eventsFor(await h.log(), url);
    const { page: observer } = await h.openPage(false);
    const [response] = await Promise.all([
        h.page.waitForNavigation({ waitUntil: "load" }),
        h.page.evaluate((url) => {
            location.href = url;
        }, url),
    ]);
    const attribute = await h.page.evaluate(() => document.documentElement.getAttribute("data-probe-script"));
    const navRequests = assetRequests(url).slice(cold);
    const navStatus = response?.status();
    const navEvents = eventsFor(await h.log(observer), url).slice(preEvents.length);
    const controlPage = observer;
    let controlConsole = 0;
    controlPage.on("console", (message) => {
        if (message.text().includes(controlMarker)) controlConsole++;
    });
    const controlResponse = await controlPage.goto(control, { waitUntil: "load" });
    let controlError;
    await controlPage
        .waitForFunction(
            (marker) => document.documentElement.getAttribute("data-probe-script") === marker,
            controlMarker,
        )
        .catch((error) => {
            controlError = String(error);
        });
    const controlAttribute = await controlPage.evaluate(() =>
        document.documentElement.getAttribute("data-probe-script"),
    );
    const controlWorks =
        !controlError && controlConsole > 0 && controlAttribute === controlMarker && controlResponse?.status() === 200;
    const navigationSafe = navRequests.length
        ? navRequests.every((entry) => !entry.auth && entry.status === 401)
        : navStatus === 200 && response.headers()["content-security-policy"] === csp;
    const ok =
        navigationSafe &&
        loaded(preload) &&
        cold === 1 &&
        signed(assetRequests(url).slice(0, cold)) === 1 &&
        preEvents.length === 1 &&
        preEvents[0].intercepted &&
        !attribute &&
        consoleMarkers.length === 0 &&
        controlWorks &&
        navEvents.every((entry) => !entry.intercepted);
    return outcome(
        ok,
        `preload width=${preload.width}, signed=${signed(assetRequests(url).slice(0, cold))}; navigation=${navRequests.length ? `server ${navRequests.length} (${statuses(navRequests)}), signed=${signed(navRequests)}` : "HTTP cache (CSP retained)"}, HTTP ${navStatus}; script console/attribute=${consoleMarkers.length}/${attribute ?? "absent"}; document intercepted=${navEvents.filter((entry) => entry.intercepted).length}; control console/attribute=${controlConsole}/${controlWorks}${controlError ? `; inconclusive SVG control: ${controlError}` : ""}`,
    );
}

async function frameCase(h, name, corp) {
    const url = addAsset(name, corp ? "e" : "e-control", "png", { corp });
    const preload = await h.page.evaluate((url) => window.probe.image(url), url);
    const beforeRequests = assetRequests(url).length;
    const beforeEvents = eventsFor(await h.log(), url);
    const frame = await h.page.evaluate((url) => window.probe.frameImage(url), url);
    const afterEvents = eventsFor(await h.log(), url);
    const network = assetRequests(url).slice(beforeRequests);
    const frameEvents = afterEvents.slice(beforeEvents.length);
    return {
        preload,
        frame,
        network,
        frameEvents,
        cold: beforeRequests,
        signed: signed(assetRequests(url).slice(0, beforeRequests)),
        preIntercepted: beforeEvents.length === 1 && beforeEvents[0].intercepted,
    };
}

async function probeFrame(h, name) {
    const main = await frameCase(h, name, true);
    const control = await frameCase(h, name, false);
    const noSignedFrame = main.network.every((entry) => !entry.auth && !entry.valid && entry.status === 401);
    const ok =
        loaded(main.preload) &&
        main.cold === 1 &&
        main.signed === 1 &&
        main.preIntercepted &&
        main.frameEvents.length === 0 &&
        main.frame.event === "error" &&
        main.frame.width === 0 &&
        main.frame.origin === "null" &&
        noSignedFrame;
    return outcome(
        ok,
        `preload signed=${main.signed}/${main.cold}; opaque frame=${main.frame.event}, width=${main.frame.width}, origin=${main.frame.origin}; worker events/intercepts=${main.frameEvents.length}/${main.frameEvents.filter((entry) => entry.intercepted).length}; server=${main.network.length} (${statuses(main.network)}), signed=${signed(main.network)}; no-CORP control=${control.frame.event}, width=${control.frame.width}, server=${control.network.length} (${statuses(control.network)}), preload signed=${control.signed}/${control.cold}`,
    );
}

function printTable() {
    console.log("\nBrowser | Probe | Result | Observations");
    console.log("--------|-------|--------|-------------");
    for (const row of results)
        console.log(`${row.browser} | ${row.probe} | ${row.status} | ${row.reason.replaceAll("\n", " ")}`);
}

try {
    if (!BROWSERS.length || BROWSERS.some((name) => !["chromium", "firefox"].includes(name)))
        throw new Error("PROBE_BROWSERS must list chromium and/or firefox");
    workDir = await mkdtemp(path.join(os.tmpdir(), "risu-direct-assets-"));
    try {
        const videoPath = path.join(workDir, "seek.webm");
        await promisify(execFile)(
            "/usr/bin/ffmpeg",
            [
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=30",
                "-t",
                "40",
                "-an",
                "-c:v",
                "libvpx",
                "-b:v",
                "1200k",
                "-g",
                "15",
                "-deadline",
                "realtime",
                "-cpu-used",
                "6",
                "-threads",
                "2",
                "-y",
                videoPath,
            ],
            { timeout: 45_000, killSignal: "SIGKILL" },
        );
        video = await readFile(videoPath);
        if (video.length < 300_000) throw new Error(`video too small (${video.length} bytes)`);
    } catch (error) {
        videoError = String(error);
    }
    await bounded(
        new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "localhost", resolve);
        }),
        "localhost server startup",
    );
    base = `http://localhost:${server.address().port}`;
    console.log(`Direct asset probe: ${base}; video=${video ? `${video.length} bytes` : videoError}`);
    for (const name of BROWSERS) {
        console.log(`Running ${name}...`);
        try {
            browser = await (name === "chromium" ? chromium : firefox).launch({
                ...(name === "chromium" ? { executablePath: chromePath } : {}),
                headless: true,
                timeout: TIMEOUT,
            });
        } catch (error) {
            const status = name === "firefox" ? "SKIP" : "FAIL";
            for (const probe of ["a", "b", "c", "d", "e"])
                results.push({ browser: name, probe, status, reason: `launch: ${String(error).split("\n")[0]}` });
            continue;
        }
        console.log(`${name} ${browser.version()}`);
        try {
            for (const [probe, run] of [
                ["a", probeKey],
                ["b", probeCache],
                ["c", probeVideo],
                ["d", probeSvg],
                ["e", probeFrame],
            ]) {
                let context;
                let h;
                let result;
                try {
                    context = await bounded(browser.newContext({ serviceWorkers: "allow" }), "context creation");
                    result = await bounded(
                        (async () => {
                            h = await fixture(context);
                            return await run(h, name);
                        })(),
                        `${name} (${probe})`,
                        65_000,
                    );
                } catch (error) {
                    result = outcome(false, String(error));
                    if (DEBUG) console.error(error);
                } finally {
                    if (context) {
                        try {
                            await bounded(context.close(), "context cleanup");
                        } catch (error) {
                            result = outcome(false, `${result?.reason ?? ""}; context cleanup: ${String(error)}`);
                        }
                    }
                }
                if (h?.pageErrors.length)
                    result = outcome(false, `${result.reason}; page errors: ${h.pageErrors.join("; ")}`);
                if (probe === "b" && result.controlLost) {
                    const control = outcome(
                        false,
                        `primary fallthrough: a navigation the worker does not answer leaves the next document uncontrolled; precondition failure, not HTTP-cache reuse; ${result.reason}`,
                    );
                    results.push({ browser: name, probe: "b-control", ...control });
                    console.log(`${name} (b-control) ${control.status}: ${control.reason}`);
                    const variant = await probeCacheWithNavigation(name);
                    results.push({ browser: name, probe: "b (navigate answered)", ...variant });
                    console.log(`${name} (b navigate answered) ${variant.status}: ${variant.reason}`);
                    result = result.controlLossOnly
                        ? { ...variant, reason: `HTTP-cache mechanic from b (navigate answered); ${variant.reason}` }
                        : outcome(false, `primary also failed a prerequisite beyond warm control; ${result.reason}`);
                }
                results.push({ browser: name, probe, ...result });
                console.log(`${name} (${probe}) ${result.status}: ${result.reason}`);
            }
        } finally {
            await bounded(browser.close(), "browser cleanup");
            browser = undefined;
        }
    }
} catch (error) {
    results.push({ browser: "harness", probe: "runtime", ...outcome(false, String(error)) });
    console.error(error);
} finally {
    try {
        if (browser) await bounded(browser.close(), "browser cleanup");
    } catch (error) {
        results.push({ browser: "harness", probe: "cleanup", ...outcome(false, String(error)) });
    }
    try {
        await bounded(
            new Promise((resolve, reject) => {
                server.close((error) => (error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
                server.closeAllConnections();
            }),
            "server cleanup",
        );
    } catch (error) {
        results.push({ browser: "harness", probe: "cleanup", ...outcome(false, String(error)) });
    }
    try {
        if (workDir) await bounded(rm(workDir, { recursive: true, force: true }), "temporary file cleanup");
    } catch (error) {
        results.push({ browser: "harness", probe: "cleanup", ...outcome(false, String(error)) });
    }
}
if (serverErrors.length)
    results.push({ browser: "harness", probe: "server", ...outcome(false, serverErrors.join("; ")) });
printTable();
const failed = results.filter((row) => row.status === "FAIL").length;
console.log(
    `\n${results.filter((row) => row.status === "PASS").length} passed, ${failed} failed, ${results.filter((row) => row.status === "SKIP").length} skipped.`,
);
process.exit(failed ? 1 : 0);
