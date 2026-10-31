// What each request costs the serving thread (audit findings F06, F07, F17, SD04, SD05, SD06). It records a baseline
// that a later run of the same case compares against, and writes one JSON document to stdout.
//
// Run from the repository root, with TMPDIR on a real disk, because a tmpfs fakes every fsync:
// `TMPDIR=/path/on/ext4 node --expose-gc docs/research/deep-audit-with-fable/probes/byte-budgets-probe.mjs > result.json`
// `--case <name>` runs one case (repeatable; default all), and only the fixtures the selected cases need are seeded.
// `PROBE_RUNS` replaces the default 7 runs of a case; `restore` and `continuation` take the smaller of 3 and that
// (`slowRuns` in the output). `PROBE_COMMIT` names the measured commit; otherwise `git rev-parse HEAD` of this file's
// tree, else "unknown". Without `--expose-gc` the runs go without a collection before each, and `gcExposed` says so.
// Progress and everything the server logs go to stderr, so stdout stays the one document.
//
// Each fixture is seeded once through the real store API, one transaction per group of rows, in its own file-backed
// store (WAL, `synchronous = FULL`, as the server opens it) under one scratch directory, removed at the end:
// - `library`: the fixture of `sync-traffic-measure.mjs` unchanged: 300 characters, 3,000 chats, a 2,000-message chat
//   at c=0/j=0, and the presets, modules, plugins and pluginStorage records.
// - `longChats`: one character with five distinct chats of 5,000 messages of 2,048 characters, roles alternating
//   `user`/`char`, about 10 MB each. The first is "the 5,000-message chat", all five are "five distinct 10 MB chats".
// - `oneLongChat`: the same with one chat, so a whole-store figure compares directly with a single-chat one.
// - `continuation`: 500 small character records with 10 chats each (the library's chat count) of 16 messages of 2,048
//   characters (about 33 KiB a chat), plus the character `largest` with 500 chats of 100 such messages (about 200 KiB
//   a chat, 100 MiB in all). The library cannot express this case: its largest character has 10 chats and it has 300
//   characters, while the client asks for 500 chats (`LOAD_CHUNK`) and 500 characters (`DETACHED_READ_CHUNK`) a call.
// Message text is one repeated sentence, as in the sync-traffic fixture, so gzip does far better here than on prose:
// `wireBytes` is a floor. The `fixtures` counts in the output come from SQL on the seeded file.
//
// `createServerContext` does not expose its store, so a case measures the store on its own handle, closes it, then
// opens a context on the same `rootDir` for the route figures. Route contexts use `authBypass`, so the auth layer does
// not distort a read; every route read sends `accept-encoding: gzip` and reads the body to the end, and the JSON bytes
// of a gzip answer come from gunzipping outside the timer. The cases that write (`restore`, `checkpoints`) work on a
// copy of the fixture's file, so every case sees the store as seeded, whichever cases ran before it.
//
// Timings are `performance.now()`, reported as `medianMs` plus the per-run `runs`, rounded to 0.1 ms. Heap is the
// `heapUsed` delta in MiB across a section, after a collection, with its result still held.
//
// Cases (keep these names and boundaries when rerunning to compare):
// - `preAuthBody` (F17): auth on, a password set. 48 chunks of 64 KiB with no `Content-Length` and no auth header, as a
//   pull-based counting `ReadableStream`, to `POST /api/resources/read`, with `/api/resources/boot` and
//   `/api/resources/boot/` as controls: bytes and chunks pulled, status, error text. The stream's default high water
//   mark prefetches one chunk, so 65,536 bytes is what a route that reads nothing pulls.
// - `readOneReference`, `readFiveChats` (F07): on `longChats`, one chat and the five distinct chats: `store.readRefs`
//   time, `JSON.stringify` time, JSON bytes, heap across both, then the whole route: ms, wire bytes.
// - `readSummaries` (F07): on `library`, `chatSummaryCollections` of all 300 characters through the store and the
//   route. The first read of a store fills the `lastMessageAt` memo, so it is reported apart from the later runs.
// - `restore` (F06): for `library` and `oneLongChat`: `backupTo` a snapshot, then `store.readSnapshot` (validation) and
//   `store.replaceAll` (install), each timed directly, with a `monitorEventLoopDelay` histogram over the run and a
//   timer yielded between the two sections so the sampler runs. The maintenance gate and the safety snapshot are not
//   part of it.
// - `checkpoints` (SD04): on the chat of `oneLongChat`, with a policy: `checkpoints.save` of a chat without pages,
//   the same save again unchanged (checkpoints deleted between runs), `autoSave` not due, and `autoSave` due (the
//   baseline reset to null before each run, autoKeep 2, so a run saves, writes the policy and prunes).
// - `open` (SD05): on `library`, `createResourceStore` then `close`, nothing changed between runs, with a
//   `listRevisions` comparison and a count of the statements that ran against `resources` during the opens.
// - `statePublication` (SD06): `diagnostics.writeState()` of a real context, which is synchronous, so its duration is
//   the serving thread's blocked time. The journal has no injectable `fs` and calls `fsyncSync` synchronously, so a
//   caller cannot wait for a promise. `realFsync` measures the real fsync on this filesystem. `asyncFsyncStub` patches
//   `fs.fsyncSync` through `syncBuiltinESMExports` (which reaches the named imports of `journal.ts` and
//   `durableWrite.ts`) with a stub that counts the call, starts an unref'd 100 ms timer and returns at once; never a
//   blocking stand-in. `blockedAt100MsFsyncMs` is derived from those: the stub's blocked ms + `fsyncCalls` x 100.
// - `continuation` (F07): the client's loop against the read route. `routeBudget` is the real contract: a loop over
//   `POST /api/resources/read` with `continue: true`, re-sending the answer's `unanswered` until it has none, at the
//   route's default budget (`MAX_READ_RESPONSE_BYTES`): rounds, bytes per round, total ms. `budgets` plays a budget the
//   route is not configured with, or units it does not use, through `playBudget`: stored bytes charged with SQL on a
//   read-only connection (a chat is `meta` plus the sum of its message rows, a collection is the order text plus the
//   sum of its chats), units served in request order until the first that would pass the budget, the first of a round
//   always served. Each of its rounds is a real read of what was served, without `continue`, re-sent with the rest until
//   nothing is left. `oneCall` is the single request of the same body without `continue`, which the route answers
//   whole, its heap figure taken from `readRefs` plus `JSON.stringify` on a store handle. `chatLoad` reads 500 chats of
//   `largest` and `detachedExport` 500 collections, `budgets` at 16 and 32 MiB, on the `continuation` fixture;
//   `syncTrafficFixture` runs both on the library as it stands (10 chats, 300 characters).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { createServerContext } from "../../../../server/src/app.ts";
import { createCheckpointService } from "../../../../server/src/data/checkpointService.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../server/src/data/kinds.ts";
import { createResourceStore } from "../../../../server/src/data/resourceStore.ts";
import { MAX_AUTO_EVERY } from "../../../../shared/chatCheckpoints.ts";
import { MAX_READ_RESPONSE_BYTES } from "../../../../shared/resources.ts";

const RUNS = positiveInteger(process.env.PROBE_RUNS, 7);
const SLOW_RUNS = Math.min(3, RUNS);
const MESSAGE_CHARS = 2048;
const LONG_CHATS = 5;
const LONG_CHAT_MESSAGES = 5000;
const CONTINUATION_CHARACTERS = 500;
const CONTINUATION_CHATS_PER_CHARACTER = 10;
const CONTINUATION_CHAT_MESSAGES = 16;
const LARGEST_CHATS = 500;
const LARGEST_CHAT_MESSAGES = 100;
const LARGEST_SEED_BATCH = 25;
const BODY_CHUNKS = 48;
const BODY_CHUNK_BYTES = 64 * 1024;
const FSYNC_DELAY_MS = 100;
const BUDGETS = [16, 32];
const INDEX_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';
const RESOURCE_WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE)\b[^;]*\bresources\b/i;

// The server logs through `console.log`; stdout belongs to the result.
console.log = console.error;
console.info = console.error;

function positiveInteger(raw, fallback) {
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid PROBE_RUNS: ${raw}`);
    return value;
}

function commitOf() {
    if (process.env.PROBE_COMMIT) return process.env.PROBE_COMMIT;
    try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: import.meta.dirname,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
    } catch {
        return "unknown";
    }
}

function scratchFilesystem() {
    const dir = tmpdir();
    try {
        const lines = execFileSync("df", ["--output=fstype", dir], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return { path: dir, type: lines.trim().split("\n").at(-1).trim() };
    } catch {
        return { path: dir, type: null };
    }
}

const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS);
const round = (ms) => Math.round(ms * 10) / 10;
const loadAverage = () => loadavg().map((load) => Math.round(load * 100) / 100);
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const timing = (runs) => ({ medianMs: round(median(runs)), runs: runs.map(round) });
const progress = (message) => console.error(`[byte-budgets] ${message}`);
const yieldFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (n) => "A character remembers the moon and speaks softly. ".repeat(Math.ceil(n / 49)).slice(0, n);
const asset = () => `assets/${randomUUID().replaceAll("-", "").repeat(2)}.png`;

// Holds a section's result across the heap reading, so nothing it allocated is collectable yet.
let held = null;
function heapBase() {
    held = null;
    globalThis.gc?.();
    return process.memoryUsage().heapUsed;
}
const heapDelta = (base) => round((process.memoryUsage().heapUsed - base) / (1024 * 1024));

const scratch = mkdtempSync(path.join(tmpdir(), "risu-byte-budgets-"));

function createRoot(name, password) {
    const rootDir = path.join(scratch, name);
    mkdirSync(path.join(rootDir, "dist"), { recursive: true });
    writeFileSync(path.join(rootDir, "dist", "index.html"), INDEX_HTML);
    if (password !== undefined) {
        mkdirSync(path.join(rootDir, "save", "server"), { recursive: true });
        writeFileSync(path.join(rootDir, "save", "server", "password"), password);
    }
    return rootDir;
}

const openStore = (file) => createResourceStore({ file, kinds });

/** Runs `body` with a context on `rootDir`, disposing it after. */
async function withContext(rootDir, options, body) {
    const context = createServerContext({ rootDir, ...options });
    try {
        return await body(context);
    } finally {
        await context.dispose();
    }
}

/** A copy of the fixture's store for a case that writes, in the case's own directory. */
function fixtureCopy(fixture, caseName) {
    const dir = path.join(scratch, `${caseName}-${fixture.name}`);
    mkdirSync(dir);
    const file = path.join(dir, "resources.sqlite");
    copyFileSync(fixture.file, file);
    return { dir, file };
}

const chatGroup = (characterId, chatId, name, message, persona) => ({
    characterId,
    chatId,
    baseRevision: null,
    ops: [
        {
            op: "create",
            chat: {
                name,
                fmIndex: -1,
                bindedPersona: persona.person,
                promptPresetId: persona.pid,
                modelPresetId: persona.mid,
                message,
            },
        },
    ],
});
const bindings = () => ({ pid: randomUUID(), mid: randomUUID(), person: randomUUID() });
const alternating = (count) =>
    Array.from({ length: count }, (_, i) => ({
        chatId: randomUUID(),
        role: i % 2 ? "char" : "user",
        data: text(MESSAGE_CHARS),
    }));

function fixturePaths(name) {
    const rootDir = createRoot(name);
    return { name, rootDir, file: path.join(rootDir, "save", "data", "resources.sqlite") };
}

function seedLibrary() {
    const fixture = fixturePaths("library");
    const store = openStore(fixture.file);
    const ids = Array.from({ length: 300 }, () => randomUUID());
    const persona = bindings();
    const chatIds = new Map(ids.map((id) => [id, []]));
    try {
        for (let c = 0; c < 300; c++) {
            const chaId = ids[c];
            const char = {
                chaId,
                name: `Character ${c}`,
                desc: text(8192),
                firstMessage: text(2048),
                globalLore: Array.from({ length: 100 }, (_, i) => ({ key: `lore-${i}`, content: text(1024) })),
                additionalAssets: Array.from({ length: 100 }, (_, i) => [`asset-${i}`, asset(), "png"]),
                emotionImages: Array.from({ length: 20 }, (_, i) => [`emotion-${i}`, asset()]),
            };
            store.applyChanges({
                ops: [{ kind: kinds.get("characters"), id: chaId, baseRevision: null, data: char }],
                chats: Array.from({ length: 10 }, (_, j) => {
                    const chatId = randomUUID();
                    chatIds.get(chaId).push(chatId);
                    return chatGroup(
                        chaId,
                        chatId,
                        `Chat ${j}`,
                        c === 0 && j === 0
                            ? Array.from({ length: 2000 }, () => ({
                                  chatId: randomUUID(),
                                  role: "user",
                                  data: text(2048),
                              }))
                            : [],
                        persona,
                    );
                }),
            });
        }
        const put = (kind, data) =>
            store.applyChanges({
                ops: [
                    {
                        kind: kinds.get(kind),
                        id: "main",
                        baseRevision: store.revisionOf(kinds.get(kind), "main"),
                        data,
                    },
                ],
            });
        put(
            "presets",
            Array.from({ length: 50 }, (_, i) => ({
                id: randomUUID(),
                name: `Preset ${i}`,
                mainPrompt: text(16384),
                jailbreak: text(8192),
            })),
        );
        put(
            "modules",
            Array.from({ length: 20 }, (_, i) => ({
                id: randomUUID(),
                name: `Module ${i}`,
                lorebook: Array.from({ length: 300 }, (_, j) => ({ key: `lore-${j}`, content: text(1024) })),
                assets: Array.from({ length: 500 }, (_, j) => [`asset-${j}`, asset(), "png"]),
            })),
        );
        put(
            "plugins",
            Array.from({ length: 10 }, (_, i) => ({
                name: `Plugin ${i}`,
                script: text(102400),
                enabled: true,
                realArg: { key: "v" },
            })),
        );
        put("pluginStorage", {
            _pluginStorage: { history: Array.from({ length: 1000 }, () => text(2048)), counter: 1 },
        });
    } finally {
        store.close();
    }
    return { ...fixture, ids, chatIds };
}

function seedLongChats(name, chats) {
    const fixture = fixturePaths(name);
    const store = openStore(fixture.file);
    const characterId = randomUUID();
    const chatIds = Array.from({ length: chats }, () => randomUUID());
    const persona = bindings();
    try {
        store.put(kinds.get("characters"), characterId, { chaId: characterId, name: "Long chats" }, null);
        for (const [i, chatId] of chatIds.entries()) {
            store.applyChanges({
                chats: [chatGroup(characterId, chatId, `Chat ${i}`, alternating(LONG_CHAT_MESSAGES), persona)],
            });
        }
    } finally {
        store.close();
    }
    return { ...fixture, characterId, chatIds };
}

function seedContinuation() {
    const fixture = fixturePaths("continuation");
    const store = openStore(fixture.file);
    const ids = Array.from({ length: CONTINUATION_CHARACTERS }, () => randomUUID());
    const largest = "largest";
    const largestChatIds = Array.from({ length: LARGEST_CHATS }, () => randomUUID());
    const persona = bindings();
    try {
        for (const [c, chaId] of ids.entries()) {
            store.applyChanges({
                ops: [
                    {
                        kind: kinds.get("characters"),
                        id: chaId,
                        baseRevision: null,
                        data: { chaId, name: `Character ${c}` },
                    },
                ],
                chats: Array.from({ length: CONTINUATION_CHATS_PER_CHARACTER }, (_, j) =>
                    chatGroup(chaId, randomUUID(), `Chat ${j}`, alternating(CONTINUATION_CHAT_MESSAGES), persona),
                ),
            });
        }
        store.put(kinds.get("characters"), largest, { chaId: largest, name: "Largest" }, null);
        for (let start = 0; start < LARGEST_CHATS; start += LARGEST_SEED_BATCH) {
            store.applyChanges({
                chats: largestChatIds
                    .slice(start, start + LARGEST_SEED_BATCH)
                    .map((chatId, i) =>
                        chatGroup(largest, chatId, `Chat ${start + i}`, alternating(LARGEST_CHAT_MESSAGES), persona),
                    ),
            });
        }
    } finally {
        store.close();
    }
    return { ...fixture, ids, largest, largestChatIds };
}

const SEEDS = {
    library: seedLibrary,
    longChats: () => seedLongChats("longChats", LONG_CHATS),
    oneLongChat: () => seedLongChats("oneLongChat", 1),
    continuation: seedContinuation,
};

function fixtureCounts(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    const count = (sql) => db.prepare(sql).get().n;
    try {
        return {
            characters: count("SELECT COUNT(*) AS n FROM resources WHERE kind = 'characters'"),
            chats: count("SELECT COUNT(*) AS n FROM chats"),
            messages: count("SELECT COUNT(*) AS n FROM messages"),
            resources: count("SELECT COUNT(*) AS n FROM resources"),
            fileBytes: statSync(file).size,
        };
    } finally {
        db.close();
    }
}

/** One `POST /api/resources/read`, the body read to the end: `ms` covers the request, not the gunzip after it. */
async function postRead(app, request) {
    const body = JSON.stringify(request);
    const headers = {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "accept-encoding": "gzip",
    };
    const start = performance.now();
    const response = await app.request("/api/resources/read", { method: "POST", headers, body });
    const wire = await response.arrayBuffer();
    const ms = performance.now() - start;
    if (response.status !== 200) {
        throw new Error(`read answered ${response.status}: ${Buffer.from(wire).toString("utf8").slice(0, 200)}`);
    }
    const json =
        response.headers.get("content-encoding") === "gzip" ? gunzipSync(new Uint8Array(wire)) : Buffer.from(wire);
    return { ms, wireBytes: wire.byteLength, jsonBytes: json.length, json };
}

async function routeRuns(app, request, runs) {
    const results = [];
    for (let run = 0; run < runs; run++) {
        globalThis.gc?.();
        const { ms, wireBytes, jsonBytes } = await postRead(app, request);
        results.push({ ms, wireBytes, jsonBytes });
    }
    return results;
}

async function sendCountedBody(app, route) {
    let bytesPulled = 0;
    let chunksPulled = 0;
    const body = new ReadableStream({
        pull(controller) {
            if (chunksPulled === BODY_CHUNKS) {
                controller.close();
                return;
            }
            chunksPulled += 1;
            bytesPulled += BODY_CHUNK_BYTES;
            controller.enqueue(new Uint8Array(BODY_CHUNK_BYTES));
        },
    });
    const request = new Request(`http://localhost${route}`, { method: "POST", body, duplex: "half" });
    const response = await app.request(request);
    const answer = await response.text();
    let error = answer;
    try {
        error = JSON.parse(answer).error;
    } catch {}
    return { route, bytesPulled, chunksPulled, status: response.status, error };
}

async function preAuthBody() {
    return withContext(createRoot("preAuthBody", "pw"), {}, async ({ app }) => ({
        chunks: BODY_CHUNKS,
        chunkBytes: BODY_CHUNK_BYTES,
        bytesOffered: BODY_CHUNKS * BODY_CHUNK_BYTES,
        read: await sendCountedBody(app, "/api/resources/read"),
        controls: [
            await sendCountedBody(app, "/api/resources/boot"),
            await sendCountedBody(app, "/api/resources/boot/"),
        ],
        note: "The stream's default high water mark prefetches one chunk, so a route that reads nothing still pulls 65,536 bytes.",
    }));
}

async function measureRead(fixture, options) {
    const store = openStore(fixture.file);
    const readMs = [];
    const stringifyMs = [];
    const heap = [];
    let jsonBytes = 0;
    try {
        for (let run = 0; run < RUNS; run++) {
            const base = heapBase();
            let start = performance.now();
            const read = store.readRefs([], options);
            readMs.push(performance.now() - start);
            start = performance.now();
            const json = JSON.stringify(read);
            stringifyMs.push(performance.now() - start);
            held = [read, json];
            heap.push(heapDelta(base));
            jsonBytes = Buffer.byteLength(json);
        }
        held = null;
    } finally {
        store.close();
    }
    const route = await withContext(fixture.rootDir, { authBypass: true }, ({ app }) => routeRuns(app, options, RUNS));
    return {
        store: {
            readRefs: timing(readMs),
            stringify: timing(stringifyMs),
            jsonBytes,
            heapDeltaMiB: round(median(heap)),
            heapDeltaMiBRuns: heap,
        },
        route: {
            ...timing(route.map((run) => run.ms)),
            jsonBytes: route[0].jsonBytes,
            wireBytes: route[0].wireBytes,
        },
    };
}

const readOneReference = ([fixture]) =>
    measureRead(fixture, { chats: [{ characterId: fixture.characterId, id: fixture.chatIds[0] }] });

const readFiveChats = ([fixture]) =>
    measureRead(fixture, { chats: fixture.chatIds.map((id) => ({ characterId: fixture.characterId, id })) });

const firstAndLater = (runs) => ({
    firstMs: round(runs[0]),
    laterMedianMs: runs.length > 1 ? round(median(runs.slice(1))) : null,
    runs: runs.map(round),
});

async function readSummaries([fixture]) {
    const request = { chatSummaryCollections: fixture.ids };
    // The `lastMessageAt` memo lives in the store object, so a new handle has not read summaries yet.
    const store = openStore(fixture.file);
    const readMs = [];
    const heap = [];
    let jsonBytes = 0;
    try {
        for (let run = 0; run < RUNS; run++) {
            const base = heapBase();
            const start = performance.now();
            const read = store.readRefs([], request);
            readMs.push(performance.now() - start);
            held = read;
            heap.push(heapDelta(base));
            jsonBytes = Buffer.byteLength(JSON.stringify(read));
        }
        held = null;
    } finally {
        store.close();
    }
    const route = await withContext(fixture.rootDir, { authBypass: true }, ({ app }) => routeRuns(app, request, RUNS));
    return {
        characters: fixture.ids.length,
        store: {
            ...firstAndLater(readMs),
            jsonBytes,
            heapDeltaMiB: round(median(heap)),
            heapDeltaMiBRuns: heap,
        },
        route: {
            ...firstAndLater(route.map((run) => run.ms)),
            jsonBytes: route[0].jsonBytes,
            wireBytes: route[0].wireBytes,
        },
    };
}

async function measureRestore(fixture) {
    const { dir, file } = fixtureCopy(fixture, "restore");
    const snapshot = path.join(dir, "snapshot.sqlite");
    const store = openStore(file);
    const histogram = monitorEventLoopDelay({ resolution: 1 });
    const toMs = (ns) => round(ns / 1e6);
    try {
        const backupStart = performance.now();
        await store.backupTo(snapshot);
        const backupMs = performance.now() - backupStart;
        const validateMs = [];
        const installMs = [];
        const heap = [];
        const eventLoopDelayMs = [];
        for (let run = 0; run < SLOW_RUNS; run++) {
            const base = heapBase();
            histogram.reset();
            histogram.enable();
            await yieldFor(20);
            let start = performance.now();
            const validated = store.readSnapshot(snapshot);
            validateMs.push(performance.now() - start);
            held = validated;
            heap.push(heapDelta(base));
            await yieldFor(20);
            start = performance.now();
            store.replaceAll(validated);
            installMs.push(performance.now() - start);
            await yieldFor(20);
            histogram.disable();
            eventLoopDelayMs.push({
                min: toMs(histogram.min),
                p50: toMs(histogram.percentile(50)),
                p99: toMs(histogram.percentile(99)),
                max: toMs(histogram.max),
            });
        }
        held = null;
        return {
            backupToMs: round(backupMs),
            snapshotBytes: statSync(snapshot).size,
            validate: timing(validateMs),
            install: timing(installMs),
            heapDeltaMiB: round(median(heap)),
            heapDeltaMiBRuns: heap,
            eventLoopDelayMs,
        };
    } finally {
        histogram.disable();
        store.close();
    }
}

async function restore([library, oneLongChat]) {
    return {
        note:
            "readSnapshot and replaceAll are called directly: the maintenance gate and the safety snapshot are not in " +
            "this measurement. eventLoopDelayMs measures scheduling delay, not the longest synchronous interval; " +
            "validate and install are that interval.",
        threeThousandChatStore: await measureRestore(library),
        fiveThousandMessageStore: await measureRestore(oneLongChat),
    };
}

async function checkpoints([fixture]) {
    const { file } = fixtureCopy(fixture, "checkpoints");
    const store = openStore(file);
    const { characterId } = fixture;
    const chatId = fixture.chatIds[0];
    const userTurns = LONG_CHAT_MESSAGES / 2;
    const service = createCheckpointService({ store, busy: () => false, memoryTasks: null });
    const list = () => store.checkpoints.list(characterId, chatId);
    const clear = () => {
        for (const checkpoint of list()) {
            store.checkpoints.delete(characterId, chatId, checkpoint.id, checkpoint.revision);
        }
    };
    const timed = (body) => {
        globalThis.gc?.();
        const start = performance.now();
        body();
        return performance.now() - start;
    };
    try {
        const firstSave = [];
        const unchangedSave = [];
        for (let run = 0; run < RUNS; run++) {
            clear();
            firstSave.push(timed(() => store.checkpoints.save(characterId, chatId, "Probe", "manual")));
            unchangedSave.push(timed(() => store.checkpoints.save(characterId, chatId, "Probe", "manual")));
            if (list().length !== 2) throw new Error("the two saves did not both land");
        }

        const policy = { autoEvery: MAX_AUTO_EVERY, autoKeep: 2 };
        const written = service.writePolicy({ epoch: store.epoch(), body: { characterId, chatId, ...policy } });
        if (written.status !== 200) throw new Error(`policy: ${JSON.stringify(written)}`);

        store.checkpoints.writePolicy(characterId, chatId, { ...policy, lastAutoTurns: userTurns });
        const notDueBefore = list().length;
        const autoSaveNotDue = [];
        for (let run = 0; run < RUNS; run++) {
            autoSaveNotDue.push(timed(() => service.autoSave(characterId, chatId)));
        }
        if (list().length !== notDueBefore) throw new Error("a not-due autoSave saved");

        const autoSaveDue = [];
        for (let run = 0; run < RUNS; run++) {
            store.checkpoints.writePolicy(characterId, chatId, { ...policy, lastAutoTurns: null });
            autoSaveDue.push(timed(() => service.autoSave(characterId, chatId)));
            const stored = store.checkpoints.readPolicy(characterId, chatId);
            if (stored.lastAutoTurns !== userTurns) throw new Error("a due autoSave did not save");
        }
        return {
            conditions:
                "File-backed store (WAL, synchronous FULL), one 5,000-message chat. The audit's " +
                "results record journal_mode wal, which an in-memory database cannot report, but not which store the " +
                "two saves ran on, so file-backed is the closest reading.",
            messages: LONG_CHAT_MESSAGES,
            userTurns,
            saveFirst: timing(firstSave),
            saveUnchanged: timing(unchangedSave),
            autoSaveNotDue: timing(autoSaveNotDue),
            autoSaveDue: {
                ...timing(autoSaveDue),
                note: "Pages already stored, autoKeep 2, so a run saves, writes the policy, prunes and sweeps.",
            },
        };
    } finally {
        store.close();
    }
}

async function open([fixture]) {
    const first = openStore(fixture.file);
    const before = JSON.stringify(first.listRevisions());
    first.close();

    const counts = { prepared: 0, INSERT: 0, UPDATE: 0, DELETE: 0, changes: 0 };
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql, ...rest) {
        const statement = prepare.call(this, sql, ...rest);
        const verb = RESOURCE_WRITE_SQL.exec(sql)?.[1].toUpperCase();
        if (verb) {
            counts.prepared += 1;
            const run = statement.run;
            statement.run = function (...args) {
                counts[verb] += 1;
                const result = Reflect.apply(run, this, args);
                counts.changes += Number(result.changes);
                return result;
            };
        }
        return statement;
    };
    const openMs = [];
    const closeMs = [];
    try {
        for (let run = 0; run < RUNS; run++) {
            globalThis.gc?.();
            let start = performance.now();
            const store = openStore(fixture.file);
            openMs.push(performance.now() - start);
            start = performance.now();
            store.close();
            closeMs.push(performance.now() - start);
        }
    } finally {
        DatabaseSync.prototype.prepare = prepare;
    }
    const last = openStore(fixture.file);
    const after = JSON.stringify(last.listRevisions());
    last.close();
    return {
        open: timing(openMs),
        close: timing(closeMs),
        revisionsUnchanged: before === after,
        statementsAgainstResources: {
            ...counts,
            note: "Across all runs. The DELETE runs are the retired kinds' pass; `changes` sums the rows every counted run touched.",
        },
    };
}

async function statePublication() {
    const rootDir = createRoot("statePublication");
    return withContext(rootDir, { authBypass: true }, async ({ diagnostics }) => {
        const blocked = () => {
            const start = performance.now();
            diagnostics.writeState();
            return performance.now() - start;
        };

        const realFsync = [];
        for (let run = 0; run < RUNS; run++) {
            globalThis.gc?.();
            realFsync.push(blocked());
        }

        const stubbed = [];
        const original = fs.fsyncSync;
        let fsyncCalls = 0;
        let timersFiredAfterReturn = 0;
        let timersFiredBeforeReturn = 0;
        const perPublication = [];
        for (let run = 0; run < RUNS; run++) {
            globalThis.gc?.();
            const callsBefore = fsyncCalls;
            let returned = false;
            fs.fsyncSync = () => {
                fsyncCalls += 1;
                setTimeout(() => {
                    if (returned) timersFiredAfterReturn += 1;
                    else timersFiredBeforeReturn += 1;
                }, FSYNC_DELAY_MS).unref();
            };
            syncBuiltinESMExports();
            try {
                stubbed.push(blocked());
                returned = true;
            } finally {
                fs.fsyncSync = original;
                syncBuiltinESMExports();
            }
            perPublication.push(fsyncCalls - callsBefore);
            await yieldFor(FSYNC_DELAY_MS + 50);
        }
        if (fsyncCalls === 0) throw new Error("the fsync stub was never called: the patch did not reach the journal");

        const stub = timing(stubbed);
        const callsPerPublication = median(perPublication);
        return {
            note:
                "The journal has no injectable fs and calls fsyncSync synchronously, so no caller can wait for a " +
                "promise. asyncFsyncStub returns at once and starts an unref'd timer, so its blocked time excludes " +
                "fsync; blockedAt100MsFsyncMs adds it back.",
            writeFailures: diagnostics.stats().writeFailures,
            realFsync: timing(realFsync),
            asyncFsyncStub: {
                ...stub,
                fsyncCalls: callsPerPublication,
                fsyncCallsRuns: perPublication,
                timersFiredAfterReturn,
                timersFiredBeforeReturn,
            },
            blockedAt100MsFsyncMs: {
                derived: true,
                value: round(stub.medianMs + callsPerPublication * FSYNC_DELAY_MS),
                note: "A synchronous fsync blocks the thread for its whole duration.",
            },
        };
    });
}

/** The charges `playBudget` spends: stored bytes read with SQL, before anything is parsed. */
function createCharges(file) {
    const db = new DatabaseSync(file, { readOnly: true });
    const chatRow = db.prepare("SELECT seq, octet_length(meta) AS bytes FROM chats WHERE characterId = ? AND id = ?");
    const chatMessages = db.prepare(
        "SELECT COALESCE(SUM(octet_length(data)), 0) AS bytes FROM messages WHERE chatSeq = ?",
    );
    const order = db.prepare("SELECT octet_length(ids) AS bytes FROM chatOrders WHERE characterId = ?");
    const collectionMeta = db.prepare(
        "SELECT COALESCE(SUM(octet_length(meta)), 0) AS bytes FROM chats WHERE characterId = ?",
    );
    const collectionMessages = db.prepare(
        "SELECT COALESCE(SUM(octet_length(m.data)), 0) AS bytes FROM messages AS m " +
            "JOIN chats AS c ON c.seq = m.chatSeq WHERE c.characterId = ?",
    );
    return {
        chat({ characterId, id }) {
            const row = chatRow.get(characterId, id);
            return row ? row.bytes + chatMessages.get(row.seq).bytes : 0;
        },
        collection(characterId) {
            return (
                (order.get(characterId)?.bytes ?? 0) +
                collectionMeta.get(characterId).bytes +
                collectionMessages.get(characterId).bytes
            );
        },
        close: () => db.close(),
    };
}

/** The units a budget may leave out, in request order. `characterGroups` puts every chat of a character in one. */
function unitsOf({ chats = [], chatCollections = [] }, unitModel) {
    const units = [];
    if (unitModel === "characterGroups") {
        const groups = new Map();
        for (const chat of chats) {
            if (!groups.has(chat.characterId)) {
                const group = { chats: [], chatCollections: [] };
                groups.set(chat.characterId, group);
                units.push(group);
            }
            groups.get(chat.characterId).chats.push(chat);
        }
    } else {
        for (const chat of chats) units.push({ chats: [chat], chatCollections: [] });
    }
    for (const characterId of chatCollections) units.push({ chats: [], chatCollections: [characterId] });
    return units;
}

/** Splits a remaining request into what a round serves and what it leaves `unanswered`, in the request's shapes. */
function playBudget(charges, remaining, budgetBytes, unitModel) {
    const units = unitsOf(remaining, unitModel);
    const shape = (list) => {
        const request = {};
        const chats = list.flatMap((unit) => unit.chats);
        const chatCollections = list.flatMap((unit) => unit.chatCollections);
        if (chats.length > 0) request.chats = chats;
        if (chatCollections.length > 0) request.chatCollections = chatCollections;
        return request;
    };
    let chargedBytes = 0;
    let served = 0;
    for (const unit of units) {
        const charge =
            unit.chats.reduce((sum, chat) => sum + charges.chat(chat), 0) +
            unit.chatCollections.reduce((sum, characterId) => sum + charges.collection(characterId), 0);
        if (served > 0 && chargedBytes + charge > budgetBytes) break;
        chargedBytes += charge;
        served += 1;
    }
    return { served: shape(units.slice(0, served)), unanswered: shape(units.slice(served)), chargedBytes };
}

/** One client call: rounds of `playBudget` and a real read, until nothing is unanswered. */
async function playLoop(app, charges, request, budgetBytes, unitModel) {
    const rounds = [];
    let remaining = request;
    let chargeMs = 0;
    while (Object.keys(remaining).length > 0) {
        const start = performance.now();
        const { served, unanswered, chargedBytes } = playBudget(charges, remaining, budgetBytes, unitModel);
        chargeMs += performance.now() - start;
        globalThis.gc?.();
        const { ms, wireBytes, jsonBytes, json } = await postRead(app, served);
        const answer = JSON.parse(json.toString("utf8"));
        const answered = (answer.chats ?? []).filter((chat) => chat.data !== null).length;
        const collections = (answer.chatCollections ?? []).filter((collection) => collection.order !== null).length;
        if (answered !== (served.chats?.length ?? 0) || collections !== (served.chatCollections?.length ?? 0)) {
            throw new Error(`a round answered ${answered} chats and ${collections} collections of ${chargedBytes}`);
        }
        rounds.push({ chargedBytes, jsonBytes, wireBytes, ms });
        remaining = unanswered;
    }
    return { rounds, chargeMs };
}

async function budgetRuns(app, charges, request, budgetMiB, unitModel) {
    const budgetBytes = budgetMiB * 1024 * 1024;
    const runs = [];
    for (let run = 0; run < SLOW_RUNS; run++) {
        runs.push(await playLoop(app, charges, request, budgetBytes, unitModel));
    }
    const { rounds } = runs[0];
    return {
        rounds: rounds.length,
        perRound: rounds.map((first, i) => ({
            chargedBytes: first.chargedBytes,
            jsonBytes: first.jsonBytes,
            wireBytes: first.wireBytes,
            ms: round(median(runs.map((played) => played.rounds[i].ms))),
        })),
        totalMs: timing(runs.map((played) => played.rounds.reduce((sum, { ms }) => sum + ms, 0))),
        chargeMs: timing(runs.map((played) => played.chargeMs)),
    };
}

/** One client call over the real contract: `continue: true`, re-sending what the answer left `unanswered`. */
async function continuedLoop(app, request) {
    const rounds = [];
    let remaining = request;
    let answered = 0;
    let collections = 0;
    while (remaining) {
        globalThis.gc?.();
        const { ms, wireBytes, jsonBytes, json } = await postRead(app, { ...remaining, continue: true });
        const answer = JSON.parse(json.toString("utf8"));
        const roundChats = (answer.chats ?? []).filter((chat) => chat.data !== null).length;
        const roundCollections = (answer.chatCollections ?? []).filter((entry) => entry.order !== null).length;
        if (roundChats + roundCollections === 0) throw new Error(`round ${rounds.length + 1} answered nothing`);
        answered += roundChats;
        collections += roundCollections;
        rounds.push({ jsonBytes, wireBytes, ms });
        remaining = answer.unanswered;
    }
    if (answered !== (request.chats?.length ?? 0) || collections !== (request.chatCollections?.length ?? 0)) {
        throw new Error(`the rounds answered ${answered} chats and ${collections} collections`);
    }
    return rounds;
}

async function routeBudgetRuns(app, request) {
    const runs = [];
    for (let run = 0; run < SLOW_RUNS; run++) {
        runs.push(await continuedLoop(app, request));
    }
    const [rounds] = runs;
    return {
        budgetBytes: MAX_READ_RESPONSE_BYTES,
        rounds: rounds.length,
        perRound: rounds.map((first, i) => ({
            jsonBytes: first.jsonBytes,
            wireBytes: first.wireBytes,
            ms: round(median(runs.map((played) => played[i].ms))),
        })),
        totalMs: timing(runs.map((played) => played.reduce((sum, { ms }) => sum + ms, 0))),
    };
}

async function scenario(app, charges, request, heapDeltaMiB, unitModels, note) {
    const oneCall = await routeRuns(app, request, SLOW_RUNS);
    progress("continuation: the route's own budget");
    const routeBudget = await routeBudgetRuns(app, request);
    const budgets = {};
    for (const budgetMiB of BUDGETS) {
        const models = {};
        for (const unitModel of unitModels) {
            progress(`continuation: ${budgetMiB} MiB, ${unitModel}`);
            models[unitModel] = await budgetRuns(app, charges, request, budgetMiB, unitModel);
        }
        budgets[`${budgetMiB}MiB`] = models;
    }
    return {
        ...(note ? { note } : {}),
        oneCall: {
            ...timing(oneCall.map((run) => run.ms)),
            jsonBytes: oneCall[0].jsonBytes,
            wireBytes: oneCall[0].wireBytes,
            heapDeltaMiB,
        },
        routeBudget,
        budgets,
    };
}

/** `readRefs` plus `JSON.stringify` with both held: the answer's text is gone by the time a route returns. */
function storeHeap(file, requests) {
    const store = openStore(file);
    try {
        return requests.map((request) => {
            const base = heapBase();
            const read = store.readRefs([], request);
            const json = JSON.stringify(read);
            held = [read, json];
            const delta = heapDelta(base);
            held = null;
            return delta;
        });
    } finally {
        store.close();
    }
}

const UNIT_MODELS_NOTE =
    "The two unit models disagree. chatUnits makes each chat a unit, so the load continues in rounds. characterGroups " +
    "puts every chat naming one character in its one group, so the whole load is the always-served first group, in " +
    "one round.";

async function continuationOn(fixture, chatLoad, detachedExport) {
    const [chatLoadHeap, exportHeap] = storeHeap(fixture.file, [chatLoad, detachedExport]);
    const charges = createCharges(fixture.file);
    try {
        return await withContext(fixture.rootDir, { authBypass: true }, async ({ app }) => ({
            chatLoad: await scenario(
                app,
                charges,
                chatLoad,
                chatLoadHeap,
                ["chatUnits", "characterGroups"],
                UNIT_MODELS_NOTE,
            ),
            detachedExport: await scenario(app, charges, detachedExport, exportHeap, ["collections"]),
        }));
    } finally {
        charges.close();
    }
}

async function continuation([fixture, library]) {
    const chatLoad = { chats: fixture.largestChatIds.map((id) => ({ characterId: fixture.largest, id })) };
    const largestLibrary = library.ids[0];
    const libraryChatLoad = {
        chats: library.chatIds.get(largestLibrary).map((id) => ({ characterId: largestLibrary, id })),
    };
    return {
        note:
            "routeBudget is the route's own budget, with continue: true and the real unanswered field; its charging " +
            "is inside totalMs. budgets plays a budget over SQL charges and re-sends the rest without continue; " +
            "chargeMs is that charging apart from its totalMs. totalMs sums the rounds' routes. " +
            "oneCall.heapDeltaMiB is readRefs plus JSON.stringify on a store handle, with both held.",
        ...(await continuationOn(fixture, chatLoad, { chatCollections: fixture.ids })),
        syncTrafficFixture: {
            note: "The library as it stands: its largest character's 10 chats, and its 300 characters.",
            ...(await continuationOn(library, libraryChatLoad, { chatCollections: library.ids })),
        },
    };
}

const CASES = {
    preAuthBody: { fixtures: [], run: preAuthBody },
    readOneReference: { fixtures: ["longChats"], run: readOneReference },
    readFiveChats: { fixtures: ["longChats"], run: readFiveChats },
    readSummaries: { fixtures: ["library"], run: readSummaries },
    restore: { fixtures: ["library", "oneLongChat"], run: restore },
    checkpoints: { fixtures: ["oneLongChat"], run: checkpoints },
    open: { fixtures: ["library"], run: open },
    statePublication: { fixtures: [], run: statePublication },
    continuation: { fixtures: ["continuation", "library"], run: continuation },
};

const { values } = parseArgs({ options: { case: { type: "string", multiple: true } } });
const selected = values.case ?? Object.keys(CASES);
for (const name of selected) {
    if (!Object.hasOwn(CASES, name)) {
        throw new Error(`Unknown case ${name}; the cases are ${Object.keys(CASES).join(", ")}`);
    }
}

try {
    const seeded = {};
    const fixtures = {};
    for (const name of new Set(selected.flatMap((caseName) => CASES[caseName].fixtures))) {
        progress(`seeding ${name}`);
        const start = performance.now();
        seeded[name] = SEEDS[name]();
        fixtures[name] = fixtureCounts(seeded[name].file);
        progress(`seeded ${name} in ${round(performance.now() - start)} ms`);
    }

    const loadBefore = loadAverage();
    const cases = {};
    for (const name of Object.keys(CASES)) {
        if (!selected.includes(name)) continue;
        progress(`case ${name}`);
        cases[name] = await CASES[name].run(CASES[name].fixtures.map((fixture) => seeded[fixture]));
    }

    const loadAfter = loadAverage();

    const memory = new DatabaseSync(":memory:");
    const sqlite = memory.prepare("SELECT sqlite_version() AS version").get().version;
    memory.close();
    const result = {
        probe: "byte-budgets-probe",
        commit: commitOf(),
        node: process.version,
        sqlite,
        gcExposed: typeof globalThis.gc === "function",
        scratchFilesystem: scratchFilesystem(),
        loadAverage: { before: loadBefore, after: loadAfter },
        runs: RUNS,
        slowRuns: { runs: SLOW_RUNS, cases: ["restore", "continuation"] },
        fixtures,
        cases,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
    rmSync(scratch, { recursive: true, force: true });
}
