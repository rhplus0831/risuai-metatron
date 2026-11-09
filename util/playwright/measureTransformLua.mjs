// Measurement of the display transform's Lua cost and plugin snapshot accounting. The server runs in process
// (`createServerContext`, the real resource store, the real script worker pool, the production
// bindings), and every request goes through `app.request`, so the time is the server's own:
// authentication, admission, the job scope's snapshot, the worker round trips, Lua, CBS, the regex
// scripts, and the JSON answer, without TCP or a browser. The server exposes no internal timing, so
// the per-target figures are derived from batch times (amortized) and from one-target requests.
//
// The default fixture: one character with a 200-message chat; one module whose trigger is a Lua
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
// --messages changes the chat length; --message-bytes sets each message's UTF-8 source bytes
// (at least 128), using deterministic, varied ASCII prose with {{char}}/{{user}}. Without that
// option the original short messages are preserved. For about 6 MiB per chat, use 2000 and 3100.
// Both chats are created in one resource batch: four operations (create counts once per chat,
// not once per message), about 12 MiB of JSON for that fixture, below the 5000-operation limit in
// server/src/routes/resources.ts and the 100 MiB body limit in server/src/app.ts.
//
// --snapshot replaces timings with isolated Lua+plugin measurements, newest 64 first (descending
// message index, as the tab renders), then oldest 64. Every target still sets noCache. Each pending
// text gets a trivial simulated tab handler's second marker and is continued; every result must
// be ok, uncached and carry both markers. Expected over-limit refusals are counted, not failures
// of this driver. No server limits are changed.
//
// Accounting (bytes, not process heap): clear transform caches between chunk scopes, then read
// stats immediately before/after each first call, before continuing and releasing its snapshot.
// With exactly one cached configuration entry and transcript entry, their displayScope.bytes
// are the pinned shared-entry charge C (checked against pinnedEntries); no other renders run.
// A = retainedBytes(after) - retainedBytes(before) - C is the request-owned charge.
// For a representative target, measure A1 with one copy and A2 with two copies (distinct ids):
// scopeSnapshotChargeBytes = 2*A1 - A2; targetCharge[i] = A(single i) - scopeSnapshotChargeBytes.
// This isolates the scope after shared-entry exclusion and avoids copying any target charge formula from the
// server. Validate additivity against the observed chunk's reservation and pending target ids.
// If even the calibration pair/singles cannot fit, print unavailable figures with a reason;
// stats cannot reveal an unreserved scope's charge. Always report observed pending/refusal counts.
// These are exact service accounting charges for this deterministic fixture, themselves a
// conservative estimate of retained memory: allowances/shared strings can over-count, while
// worker heaps, transient allocations, result caches and idle display caches are not included.
// Capacity estimates greedily admit targets in chunk order using scope + measured target charges,
// capped at 64; they exclude C because MAX_SNAPSHOT_BYTES excludes it. They consider only that byte
// limit, so deadlines, aggregate text limits, global pressure or changed scripts can reduce actual
// admission. The directly observed counts remain authoritative if the mirrored limit drifts.
// createServerContext does not expose the transform service. Before measurement, the driver reads
// the route's `transforms` closure binding once through a local inspector Session (no listening
// socket), then disconnects; it fails if the binding cannot be read. The context.transforms fast
// path is retained as a forward-compatible branch.
//
// Usage: node util/playwright/measureTransformLua.mjs [--messages N] [--message-bytes N] [--snapshot]
// Large snapshot: node util/playwright/measureTransformLua.mjs --snapshot --messages 2000 --message-bytes 3100
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
import { parseArgs } from "node:util";
import { repoRoot } from "./stack.mjs";

const { values: options } = parseArgs({
    options: {
        messages: { type: "string", default: "200" },
        "message-bytes": { type: "string" },
        snapshot: { type: "boolean", default: false },
    },
});
const integerOption = (name, value, minimum) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
        throw new Error(`--${name} must be an integer >= ${minimum}`);
    }
    return Number(value);
};
const MESSAGES = integerOption("messages", options.messages, 1);
const MESSAGE_BYTES =
    options["message-bytes"] === undefined ? undefined : integerOption("message-bytes", options["message-bytes"], 128);
const CHUNK = 64;
const WARM_RUNS = 10;
const THRESHOLD_MS = 50;
const MARKER = " [lua]";
const PLUGIN_MARKER = " [plugin]";
const HANDLERS = "measure-display-handler-v1";
// Mirror server/src/prompt/transform.ts MAX_SNAPSHOT_BYTES; observed counts do not use this value.
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const { createServerContext } = await import(path.join(repoRoot, "server/src/app.ts"));

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
const messageText = (i) => {
    if (MESSAGE_BYTES === undefined) {
        return `Message ${i}: the quick brown fox jumps over the lazy dog, {{char}} and {{user}}.`;
    }
    const sentences = [
        "The evening train rolled past the harbor, where lanterns reflected on the quiet water.",
        "A folded map lay between the cups of tea, its margins crowded with notes about the journey.",
        "We compared the station clock with our watches and wondered whether the rain would clear.",
        "Someone in the market had described a narrow path through the orchard behind the old mill.",
        "Beyond the bridge, warm light spilled from a kitchen and the smell of fresh bread drifted outside.",
        "The conversation turned to the letter, the missing parcel, and a promise made last spring.",
        "Footsteps echoed along the stone passage while a distant bell marked the changing hour.",
        "We paused to sketch the hillside and record the names of the villages we hoped to visit.",
    ];
    let text = `Message ${i}: {{char}} and {{user}} discussed the next stage of their journey. `;
    for (let j = 0; text.length < MESSAGE_BYTES; j++) {
        text += `${sentences[(i + j) % sentences.length]} `;
    }
    // All fixture prose is ASCII, so slicing characters also sets the exact UTF-8 byte count.
    return text.slice(0, MESSAGE_BYTES);
};

// The server's root: a stub client build, public Lua files, tokenizer assets, the version, and a set password.
const rootDir = mkdtempSync(path.join(os.tmpdir(), "risu-measure-lua-"));
mkdirSync(path.join(rootDir, "dist"));
writeFileSync(path.join(rootDir, "dist", "index.html"), "<!doctype html><html><head></head><body></body></html>");
symlinkSync(path.join(repoRoot, "public"), path.join(rootDir, "public"), "dir");
mkdirSync(path.join(rootDir, "server"));
symlinkSync(path.join(repoRoot, "server/assets"), path.join(rootDir, "server/assets"), "dir");
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

const transformService = async () => {
    if (context.transforms) return context.transforms;
    const { Session } = await import("node:inspector/promises");
    const session = new Session();
    const bridgeKey = `measureTransformLua:${rootDir}`;
    const bridge = {
        handler: app.routes.findLast((route) => route.path === "/api/transform" && route.method === "POST")?.handler,
    };
    globalThis[bridgeKey] = bridge;
    session.connect();
    try {
        const { result: handler } = await session.post("Runtime.evaluate", {
            expression: `globalThis[${JSON.stringify(bridgeKey)}].handler`,
        });
        const { internalProperties } = await session.post("Runtime.getProperties", { objectId: handler.objectId });
        const scopes = internalProperties?.find((property) => property.name === "[[Scopes]]")?.value;
        if (scopes?.objectId) {
            const { result } = await session.post("Runtime.getProperties", {
                objectId: scopes.objectId,
                ownProperties: true,
            });
            for (const scope of result.filter((property) => /^\d+$/.test(property.name))) {
                const { result: bindings } = await session.post("Runtime.getProperties", {
                    objectId: scope.value.objectId,
                    ownProperties: true,
                });
                const service = bindings.find((property) => property.name === "transforms")?.value;
                if (!service?.objectId) continue;
                await session.post("Runtime.callFunctionOn", {
                    objectId: service.objectId,
                    functionDeclaration: `function () { globalThis[${JSON.stringify(bridgeKey)}].service = this; }`,
                });
                if (typeof bridge.service?.stats === "function" && typeof bridge.service?.pause === "function") {
                    return bridge.service;
                }
            }
        }
        throw new Error(
            "Snapshot measurement needs the route's transform service stats; no service reference was exposed",
        );
    } finally {
        session.disconnect();
        delete globalThis[bridgeKey];
    }
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
    const modelPresetId = (await api("/api/resources/modelPresets/main")).body.data[0].id;
    const personaId = (await api("/api/resources/personas/main")).body.data[0].id;
    const modules = await api("/api/resources/modules/main");

    const moduleId = "measure-lua-module";
    const messages = Array.from({ length: MESSAGES }, (_, i) => ({
        role: i % 2 ? "user" : "char",
        data: messageText(i),
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
    const request = (chatId, list, handlers) =>
        api("/api/transform", {
            clientId: "measure",
            mode: "editdisplay",
            context: {
                characterId: "measure",
                chatId,
                presetId,
                modelPresetId,
                personaId,
                selectedPersonaId: personaId,
            },
            client: { viewport: { width: 1280, height: 800 }, browserLanguage: "en" },
            targets: list,
            ...(handlers === undefined ? {} : { handlers }),
        });
    if (options.snapshot) {
        const transforms = await transformService();
        const sourceBytes = messages.reduce((sum, message) => sum + Buffer.byteLength(message.data), 0);
        log("snapshot fixture", {
            messages: MESSAGES,
            sourceBytesPerChat: sourceBytes,
            sourceMiB: round(sourceBytes / 1024 ** 2),
        });
        for (const [name, list] of [
            ["lua/newest", targets(Math.max(0, MESSAGES - CHUNK), MESSAGES).reverse()],
            ["lua/oldest", targets(0, Math.min(CHUNK, MESSAGES))],
        ]) {
            // Only this scope's raw entries may be present in the cache stats used as C.
            transforms.pause("isolate snapshot measurement")();
            let valid = true;
            let invalid = 0;
            const verify = (ok, detail) => {
                valid &&= ok;
                if (!ok && invalid++ < 3) log(`${name}: invalid snapshot measurement`, detail);
                return ok;
            };
            const refusal = "The render's texts are over the limit of one request";
            const snapshotCall = async (chunk) => {
                const before = transforms.stats();
                verify(
                    before.active === 0 &&
                        before.queued === 0 &&
                        before.snapshots === 0 &&
                        before.retainedBytes === 0 &&
                        before.pinnedEntries === 0,
                    { before },
                );
                const answer = await request("lua", chunk, HANDLERS);
                // Capture reservations and pins BEFORE the continuation consumes the snapshot.
                const held = transforms.stats();
                const pending = answer.body?.pending ?? [];
                const failed = answer.body?.results ?? [];
                const expected = new Map(chunk.map((target) => [target.id, target]));
                const ids = [...pending, ...failed].map((entry) => entry.id);
                verify(
                    answer.status === 200 &&
                        !answer.body?.same &&
                        ids.length === chunk.length &&
                        new Set(ids).size === ids.length &&
                        ids.every((id) => expected.has(id)) &&
                        pending.every((entry) => entry.text === expected.get(entry.id)?.source + MARKER) &&
                        failed.every((entry) => entry.ok === false && entry.error === refusal) &&
                        (pending.length > 0 ? typeof answer.body?.snapshotId === "string" : !answer.body?.snapshotId),
                    { status: answer.status, body: JSON.stringify(answer.body).slice(0, 400) },
                );
                const configuration = held.displayScope.configuration;
                const transcripts = held.displayScope.transcripts;
                // A cache can omit an oversized entry. Never treat its missing bytes as zero charge.
                const sharedKnown = configuration.entries === 1 && transcripts.entries === 1;
                const sharedBytes = configuration.bytes + transcripts.bytes;
                verify(
                    held.active === 0 &&
                        held.queued === 0 &&
                        held.snapshots === (pending.length ? 1 : 0) &&
                        held.pinnedEntries === (pending.length ? 2 : 0),
                    { held },
                );
                const ownBytes =
                    pending.length && sharedKnown ? held.retainedBytes - before.retainedBytes - sharedBytes : null;
                if (pending.length) {
                    const continued = await api("/api/transform/continue", {
                        clientId: "measure",
                        snapshotId: answer.body.snapshotId,
                        texts: pending.map(({ id, text }) => ({ id, text: text + PLUGIN_MARKER })),
                    });
                    const full = continued.body?.results;
                    verify(
                        continued.status === 200 &&
                            Array.isArray(full) &&
                            full.length === pending.length &&
                            new Set(full.map((entry) => entry.id)).size === pending.length &&
                            full.every(
                                (entry) =>
                                    pending.some(({ id }) => id === entry.id) &&
                                    entry.ok === true &&
                                    entry.cached === false &&
                                    typeof entry.text === "string" &&
                                    entry.text.endsWith(MARKER + PLUGIN_MARKER),
                            ) &&
                            !continued.body.pending &&
                            !continued.body.same,
                        { continued: JSON.stringify(continued).slice(0, 400) },
                    );
                }
                const released = transforms.stats();
                verify(
                    released.active === 0 &&
                        released.queued === 0 &&
                        released.snapshots === 0 &&
                        released.retainedBytes === 0 &&
                        released.pinnedEntries === 0,
                    { released },
                );
                return { ownBytes, pending, failed, held, sharedKnown };
            };

            // Observe the actual chunk first, then calibrate without overlapping reservations.
            const observed = await snapshotCall(list);
            const singles = [];
            for (const target of list) singles.push(await snapshotCall([target]));
            const pair = await snapshotCall([list[0], { ...list[0], id: `probe-${list[0].id}` }]);
            const measurable =
                singles.every((sample) => sample.pending.length === 1 && sample.ownBytes !== null) &&
                pair.pending.length === 2 &&
                pair.ownBytes !== null;
            let scopeBytes = null;
            let charges = null;
            let capacityEstimate = null;
            let perTargetChargeBytes = null;
            if (measurable) {
                scopeBytes = 2 * singles[0].ownBytes - pair.ownBytes;
                charges = singles.map((sample) => sample.ownBytes - scopeBytes);
                const byId = new Map(list.map((target, i) => [target.id, charges[i]]));
                const expectedOwn = observed.pending.length
                    ? scopeBytes + observed.pending.reduce((sum, entry) => sum + byId.get(entry.id), 0)
                    : null;
                const shared = observed.held.displayScope;
                const consistent =
                    scopeBytes >= 0 &&
                    charges.every((bytes) => bytes > 0) &&
                    singles
                        .concat(pair)
                        .every(
                            (sample) =>
                                sample.held.displayScope.configuration.bytes === shared.configuration.bytes &&
                                sample.held.displayScope.transcripts.bytes === shared.transcripts.bytes,
                        ) &&
                    observed.ownBytes === expectedOwn;
                check(`${name}: snapshot charges reconcile`, consistent, {
                    observedOwnBytes: observed.ownBytes,
                    expectedOwnBytes: expectedOwn,
                });
                perTargetChargeBytes = {
                    min: Math.min(...charges),
                    median: median(charges),
                    max: Math.max(...charges),
                };
                const capacity = (limit) => {
                    let bytes = scopeBytes;
                    let count = 0;
                    for (const charge of charges) {
                        if (bytes + charge <= limit) {
                            bytes += charge;
                            count++;
                        }
                    }
                    return count;
                };
                capacityEstimate = {
                    at8MiB: capacity(MAX_SNAPSHOT_BYTES),
                    at16MiB: capacity(2 * MAX_SNAPSHOT_BYTES),
                };
            }
            check(
                `${name}: first calls uncached, refusals classified, continuations carry both markers, reservations released`,
                valid,
            );
            const shared = observed.held.displayScope;
            log(
                `snapshot ${name}`,
                JSON.stringify({
                    targets: list.length,
                    scopeSnapshotChargeBytes: scopeBytes,
                    sharedEntryBytes: observed.sharedKnown
                        ? { configuration: shared.configuration.bytes, transcripts: shared.transcripts.bytes }
                        : null,
                    perTargetChargeBytes,
                    observed: {
                        pending: observed.pending.length,
                        overLimit: observed.failed.length,
                        permanent: observed.failed.filter((entry) => entry.permanent === true).length,
                        nonPermanent: observed.failed.filter((entry) => entry.permanent !== true).length,
                        retainedBytesBeforeContinue: observed.held.retainedBytes,
                        ownSnapshotBytes: observed.ownBytes,
                    },
                    capacityEstimate,
                    ...(!measurable
                        ? {
                              unavailableReason:
                                  "Calibration singles or pair could not be reserved; stats do not expose unreserved charges.",
                          }
                        : {}),
                }),
            );
        }
    } else {
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
    }
} finally {
    await context.dispose();
    rmSync(rootDir, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
