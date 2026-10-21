// Measurement of the display transform's per-request Lua cost. The server runs in process
// (`createServerContext`, the real resource store, the real script worker pool, the production
// bindings), and every request goes through `app.request`, so the time is the server's own:
// authentication, admission, the job scope's snapshot, the worker round trips, Lua, CBS, the regex
// scripts, and the JSON answer, without TCP or a browser. The server exposes no internal timing, so
// the per-target figures are derived from batch times (amortized) and from one-target requests.
//
// The fixture: one character with a 200-message chat; one module whose trigger is a Lua
// `listenEdit("editDisplay", ...)` that appends a marker, enabled by the chat (`chat.modules`); and a
// second chat with the same messages and no module, the no-Lua baseline. Every target sets `noCache`
// (the server reads it per target), and every answer must be `ok`, not `cached`, and (with Lua) carry
// the marker, so no measurement can come from the cache or from a failed target.
//
// Measured, Lua and no Lua alike:
// - cold: the first 200-target batch after the server starts (the workers boot on the first task);
// - batch: the 200 targets as the tab sends them (64-target chunks, concurrently), 10 warm runs;
// - single: 200 one-target requests one after another, warm. Reported: every batch observation, the
//   median, the amortized time per target (batch / 200), the single-target median, and the Lua
//   minus no-Lua differences. The follow-up threshold (50 ms per target) is checked against the
//   warm amortized batch time per target with Lua.
//
// Usage: node util/playwright/measureTransformLua.mjs
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { repoRoot } from "./stack.mjs";

const { createServerContext } = await import(path.join(repoRoot, "server/src/app.ts"));

const MESSAGES = 200;
const CHUNK = 64;
const WARM_RUNS = 10;
const THRESHOLD_MS = 50;
const MARKER = " [lua]";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}`);
};
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (n) => +n.toFixed(2);

// The server's root: a stub client build, the public folder, the version, and a set password.
const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-measure-lua-"));
mkdirSync(path.join(rootDir, "dist"));
writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
symlinkSync(path.join(repoRoot, "public"), path.join(rootDir, "public"), "dir");
cpSync(path.join(repoRoot, "version.json"), path.join(rootDir, "version.json"));
mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
writeFileSync(path.join(rootDir, "save", "server", "password"), "pw");

const log = console.log;
const quiet = !process.env.DEBUG;
if (quiet) {
    console.warn = () => {};
}
const context = createServerContext({ rootDir });
const app = context.app;

// An ES256 key registered with the password, as a browser tab registers its key.
const keyPair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const publicJwk = await webcrypto.subtle.exportKey("jwk", keyPair.publicKey);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = async () => {
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: "ES256", typ: "JWT" })}.${b64({ iat: now, exp: now + 300, pub: publicJwk })}`;
    const signature = await webcrypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        Buffer.from(head),
    );
    return `${head}.${Buffer.from(signature).toString("base64url")}`;
};
let epoch = "";
const api = async (url, body) => {
    const response = await app.request(url, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
        headers: { "risu-auth": await jwt(), "x-resource-epoch": epoch, "content-type": "application/json" },
    });
    let parsed = null;
    try {
        parsed = await response.json();
    } catch {}
    return { status: response.status, body: parsed };
};

try {
    const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "pw", publicKey: publicJwk }),
    });
    check("login", login.status === 200, login.status);
    epoch = (await api("/api/resources/ui")).body.epoch;
    const presetId = (await api("/api/resources/presets/main")).body.data[0].id;
    const personaId = (await api("/api/resources/personas/main")).body.data[0].id;
    const modules = await api("/api/resources/modules/main");

    const moduleId = "measure-lua-module";
    const messages = Array.from({ length: MESSAGES }, (_, i) => ({
        role: i % 2 ? "user" : "char",
        data: `Message ${i}: the quick brown fox jumps over the lazy dog, {{char}} and {{user}}.`,
        chatId: `m${i}`,
    }));
    const chat = (id, extra = {}) => ({
        characterId: "measure",
        chatId: id,
        baseRevision: null,
        ops: [{ op: "create", chat: { id, name: id, message: messages, ...extra } }],
    });
    const seeded = await api("/api/resources/batch", {
        ops: [
            {
                kind: "modules",
                id: "main",
                baseRevision: modules.body?.revision ?? null,
                data: [
                    ...(modules.body?.data ?? []),
                    {
                        id: moduleId,
                        name: "Lua display edit",
                        description: "",
                        trigger: [
                            {
                                comment: "lua",
                                type: "start",
                                conditions: [],
                                effect: [
                                    {
                                        type: "triggerlua",
                                        code: `listenEdit("editDisplay", function(id, value, meta)\n    return value .. "${MARKER}"\nend)`,
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                kind: "characters",
                id: "measure",
                baseRevision: null,
                data: {
                    chaId: "measure",
                    name: "Measure",
                    type: "character",
                    firstMessage: "hi",
                    desc: "",
                    globalLore: [],
                    customscript: [],
                    triggerscript: [],
                },
            },
        ],
        chats: [chat("lua", { modules: [moduleId] }), chat("plain")],
    });
    check("seed: stored", seeded.status === 200, seeded.status === 200 ? undefined : seeded.body);

    const targets = (from, to) =>
        messages.slice(from, to).map((message, i) => ({
            id: `t${from + i}`,
            kind: "message",
            sourceId: "measure",
            chatIndex: from + i,
            messageId: message.chatId,
            source: message.data,
            noCache: true,
        }));
    const request = (chatId, list) =>
        api("/api/transform", {
            clientId: "measure",
            mode: "editdisplay",
            context: { characterId: "measure", chatId, presetId, personaId, selectedPersonaId: personaId },
            client: { viewport: { width: 1280, height: 800 }, browserLanguage: "en" },
            targets: list,
        });
    // Every answer: 200, every target `ok` and not cached; with Lua, every text ends with the marker.
    let invalid = 0;
    const validate = (response, lua, count) => {
        const list = response.body?.results;
        const ok =
            response.status === 200 &&
            Array.isArray(list) &&
            list.length === count &&
            list.every((r) => r.ok === true && r.cached === false && r.text.endsWith(MARKER) === lua);
        if (!ok && invalid++ < 3) {
            log("invalid answer", JSON.stringify(response.body).slice(0, 400));
        }
        return ok;
    };
    // The tab's shape: 64-target chunks of the 200, sent concurrently; the batch ends with the last.
    const batch = async (chatId, lua) => {
        const started = performance.now();
        const answers = await Promise.all(
            Array.from({ length: Math.ceil(MESSAGES / CHUNK) }, (_, c) =>
                request(chatId, targets(c * CHUNK, Math.min(MESSAGES, (c + 1) * CHUNK))),
            ),
        );
        const elapsed = performance.now() - started;
        const valid = answers.every((answer, c) =>
            validate(answer, lua, Math.min(MESSAGES, (c + 1) * CHUNK) - c * CHUNK),
        );
        return { elapsed, valid };
    };
    const singles = async (chatId, lua) => {
        const times = [];
        let valid = true;
        for (let i = 0; i < MESSAGES; i++) {
            const started = performance.now();
            const answer = await request(chatId, targets(i, i + 1));
            times.push(performance.now() - started);
            valid &&= validate(answer, lua, 1);
        }
        return { times, valid };
    };

    const report = {};
    for (const [name, chatId, lua] of [
        ["lua", "lua", true],
        ["plain", "plain", false],
    ]) {
        // The Lua configuration runs first, so its cold batch is the server's first task.
        const cold = await batch(chatId, lua);
        const warm = [];
        let valid = cold.valid;
        for (let run = 0; run < WARM_RUNS; run++) {
            const result = await batch(chatId, lua);
            warm.push(result.elapsed);
            valid &&= result.valid;
        }
        const single = await singles(chatId, lua);
        valid &&= single.valid;
        check(`${name}: every target ok, uncached${lua ? ", with the Lua edit" : ", without a Lua edit"}`, valid);
        report[name] = {
            coldBatchMs: round(cold.elapsed),
            warmBatchMs: warm.map(round),
            warmBatchMedianMs: round(median(warm)),
            warmPerTargetMs: round(median(warm) / MESSAGES),
            singleMedianMs: round(median(single.times)),
            singleN: single.times.length,
        };
        log(`${name} (${MESSAGES} targets, ${Math.ceil(MESSAGES / CHUNK)} concurrent chunks)`, report[name]);
    }
    const luaShare = {
        warmBatchMs: round(report.lua.warmBatchMedianMs - report.plain.warmBatchMedianMs),
        perTargetMs: round(report.lua.warmPerTargetMs - report.plain.warmPerTargetMs),
        singleMs: round(report.lua.singleMedianMs - report.plain.singleMedianMs),
    };
    log("Lua minus no Lua (medians)", luaShare);
    log(
        `${report.lua.warmPerTargetMs <= THRESHOLD_MS ? "within" : "OVER"} the ${THRESHOLD_MS} ms per-target threshold: warm amortized ${report.lua.warmPerTargetMs} ms per target with Lua`,
    );
} finally {
    await context.dispose();
    rmSync(rootDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
