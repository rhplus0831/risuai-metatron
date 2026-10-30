// What one streaming checkpoint of a send costs on the server (audit finding SD01).
//
// Run from the repository root: `node --expose-gc docs/research/deep-audit-with-fable/probes/checkpoint-probe.mjs`
// (without `--expose-gc` the runs go without a collection before each). `PROBE_COMMIT` names the measured commit
// in the output; otherwise `git rev-parse HEAD` of this file's tree, else "unknown".
//
// Fixture: character `c`, chat `k` with 5,000 messages of about 2 KiB, bound to the default prompt preset, model
// preset, and persona. A real generation job registry runs a custom runner with a real owner socket attached
// (`/api/generations/<jobId>/ws?clientId=probe&attach=1`). The runner appends a `char` reply and begins its
// generation (unmeasured), then writes seven checkpoints, each a `setText` of that reply to a different 32 KiB
// text with its generation and `covers`, as the runner's stream checkpoint does, then a final write and `done`.
//
// Each checkpoint mirrors the runner's `writeOwn` (server/src/prompt/runner.ts, a closure inside `runSend`)
// call for call: `flushChatMetadata`, `refreshChat`, `job.write`, `refreshChatAfterWrite`, `job.emitRecords`.
// When `writeOwn` changes, change `writeOwn` below the same way.
//
// Phases per run (keep these names and boundaries when rerunning to compare):
// - `writeMs`: `job.write(...)` (the store's `applyChanges`, the feed publication inside it).
// - `scopeMs`: `scopeBeforeMs` (`flushChatMetadata` + `refreshChat` before the write) + `scopeAfterMs`
//   (`refreshChatAfterWrite`).
// - `emitMs`: the whole `job.emitRecords(...)`, split into `readMs` (time inside `store.readRefs` and
//   `store.chatMeta` during it) and `baselineMs = emitMs - readMs` (baseline, diff, and the socket send). Once
//   the job's working baseline makes the patch, `emitMs` reads only the chat's revision (`store.chatRevision`,
//   counted in `baselineMs`), so `readMs` is 0.
// - `totalMs`: `writeMs + scopeMs + emitMs`.
// Also per run: `ownerPatchBytes` (the `chatPatch` frame the owner socket received for that checkpoint),
// `feedPatchBytes` / `feedEventBytes` (UTF-8 bytes of `JSON.stringify` of the feed's chat patch and of the
// whole `change` event), and `wholeTranscriptReads` by phase: `.all()` calls of the store's whole-chat message
// SELECT at the SQL boundary.
//
// A second JSON line (label `feed-entries-st04-sd03`, after the job ended, in its own small store with a feed) reads
// what a real `change` event carries for the audit's findings ST04 and SD03:
// - `memoryToggle`: one `meta` set of `autoTranslate` on a three-message chat with 100 KiB of `supaMemoryData`:
//   the `delta` bytes, whether `patch` is present, the fields, whether the entry has `summaryBase` or `summary`.
// - `textCheckpoint`: one `setText` on that chat: the bytes of the entry's `summaryBase` and whether `summary` is
//   present.
// - `publication`: one `applyChanges` of 100 `setText` groups, one per chat, of 60,000 characters each: the event's
//   UTF-8 bytes, how many entries kept a patch and a `summaryBase`, the optional payload bytes they sum to, and the
//   time spent, serialization as `routes/events.ts` does it included.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { WebSocket } from "ws";
import { createChangeFeed } from "../../../../server/src/data/changeFeed.ts";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../server/src/data/kinds.ts";
import { createResourceStore } from "../../../../server/src/data/resourceStore.ts";
import { createSnapshotManager } from "../../../../server/src/data/snapshots.ts";
import { createGenerationJobs } from "../../../../server/src/jobs/generationJobs.ts";
import { createGenerationLock } from "../../../../server/src/jobs/generationLock.ts";
import {
    flushChatMetadata,
    loadJobScope,
    refreshChat,
    refreshChatAfterWrite,
} from "../../../../server/src/jobs/jobScope.ts";
import { NO_GENERATION_HOOKS } from "../../../../shared/jobs.ts";

const MESSAGES = 5000;
const MESSAGE_FILL = 2048;
const REPLY_CHARS = 32 * 1024;
const RUNS = 7;
const WHOLE_TRANSCRIPT_SQL = "SELECT data FROM messages WHERE chatSeq = ? ORDER BY position";
const FEED_MEMORY_CHARS = 100 * 1024;
const FEED_CHATS = 100;
const FEED_TEXT_CHARS = 60000;

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

// The SQL boundary: every whole-transcript read, attributed to the phase running at that moment.
let phase = "other";
const reads = {};
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
    const statement = prepare.call(this, sql, ...rest);
    if (sql === WHOLE_TRANSCRIPT_SQL) {
        const all = statement.all;
        statement.all = function (...args) {
            reads[phase] = (reads[phase] ?? 0) + 1;
            return Reflect.apply(all, this, args);
        };
    }
    return statement;
};

const scratch = mkdtempSync(path.join(tmpdir(), "risu-checkpoint-probe-"));
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS),
    lock = createGenerationLock(),
    feed = createChangeFeed();
const store = createResourceStore({ file: ":memory:", kinds, guard: lock, feed });
const snapshots = createSnapshotManager({ store, dir: scratch + "/checkpoint-snapshots" });
const firstId = (name) => store.get(kinds.get(name), "main").data[0].id;
const bound = { presetId: firstId("presets"), modelPresetId: firstId("modelPresets"), personaId: firstId("personas") };
store.applyChanges({
    ops: [{ kind: kinds.get("characters"), id: "c", baseRevision: null, data: { chaId: "c", name: "C" } }],
    chats: [
        {
            characterId: "c",
            chatId: "k",
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: {
                        id: "k",
                        name: "K",
                        promptPresetId: bound.presetId,
                        modelPresetId: bound.modelPresetId,
                        bindedPersona: bound.personaId,
                        message: Array.from({ length: MESSAGES }, (_, i) => ({
                            role: i % 2 ? "char" : "user",
                            chatId: `m${i}`,
                            data: `${i}:` + "x".repeat(MESSAGE_FILL),
                        })),
                    },
                },
            ],
        },
    ],
});

let lastChange = null;
feed.subscribe((event) => {
    if (event.type === "change" && event.changes.chats.some((chat) => chat.characterId === "c" && chat.id === "k")) {
        lastChange = event;
    }
});

// Chat frames the owner socket received, in order; `nextChatFrame` takes the next one.
const chatFrames = [];
let frameWaiter = null;
function nextChatFrame() {
    if (chatFrames.length > 0) return Promise.resolve(chatFrames.shift());
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no chat frame within 10 seconds")), 10000);
        frameWaiter = (frame) => {
            clearTimeout(timer);
            resolve(frame);
        };
    });
}
const settle = () => new Promise((r) => setTimeout(r, 20));

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const round = (ms) => +ms.toFixed(3);
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// The second output line: what the feed's `change` events carry, in a small store of its own.
function measureFeedEntries() {
    const entriesFeed = createChangeFeed();
    const entriesStore = createResourceStore({ file: ":memory:", kinds, feed: entriesFeed });
    try {
        let event = null;
        let frame = "";
        let serializeMs = 0;
        entriesFeed.subscribe((published) => {
            if (published.type !== "change") return;
            event = published;
            const at = performance.now();
            frame = JSON.stringify(published);
            serializeMs = performance.now() - at;
        });
        const group = (chatId, ops) => ({
            characterId: "c",
            chatId,
            baseRevision: entriesStore.chatRevision("c", chatId),
            ops,
        });
        const chatOf = (id, message) => ({ id, name: "K", note: "keep", fmIndex: -1, localLore: [], message });
        const row = (chatId, data) => ({ chatId, data, role: "char" });
        entriesStore.put(kinds.get("characters"), "c", { chaId: "c", name: "C" }, null);

        const rows = [row("a", "A"), row("b", "B"), row("c", "C")];
        entriesStore.applyChanges({ chats: [group("k", [{ op: "create", chat: chatOf("k", rows) }])] });
        entriesStore.applyChanges({
            chats: [group("k", [{ op: "meta", set: { supaMemoryData: "m".repeat(FEED_MEMORY_CHARS) } }])],
        });
        entriesStore.applyChanges({ chats: [group("k", [{ op: "meta", set: { autoTranslate: true } }])] });
        const toggle = event.changes.chats[0];
        const toggleEventBytes = Buffer.byteLength(frame);
        entriesStore.applyChanges({ chats: [group("k", [{ op: "setText", id: "b", text: "checkpoint" }])] });
        const checkpoint = event.changes.chats[0];

        const ids = Array.from({ length: FEED_CHATS }, (_, i) => `p${i}`);
        entriesStore.applyChanges({
            chats: ids.map((id) => group(id, [{ op: "create", chat: chatOf(id, [row("a", "A")]) }])),
        });
        const groups = ids.map((id) =>
            group(id, [{ op: "setText", id: "a", text: `${id}:`.padEnd(FEED_TEXT_CHARS, "x") }]),
        );
        const start = performance.now();
        entriesStore.applyChanges({ chats: groups });
        const applyMs = performance.now() - start;
        const entries = event.changes.chats;
        const payloads = entries.flatMap((entry) =>
            ["patch", "delta", "summary", "summaryBase"].filter((name) => name in entry).map((name) => entry[name]),
        );
        return {
            label: "feed-entries-st04-sd03",
            commit: commitOf(),
            node: process.version,
            memoryToggle: {
                fixture: { messages: rows.length, memoryField: "supaMemoryData", memoryChars: FEED_MEMORY_CHARS },
                deltaBytes: bytes(toggle.delta),
                patchPresent: "patch" in toggle,
                metaFields: toggle.delta.metaFields,
                summaryBasePresent: "summaryBase" in toggle,
                summaryPresent: "summary" in toggle,
                eventBytes: toggleEventBytes,
            },
            textCheckpoint: {
                summaryBaseBytes: bytes(checkpoint.summaryBase),
                summaryPresent: "summary" in checkpoint,
            },
            publication: {
                fixture: { chats: FEED_CHATS, textChars: FEED_TEXT_CHARS, inputBytes: bytes(groups) },
                eventBytes: Buffer.byteLength(frame),
                entries: entries.length,
                patchesKept: entries.filter((entry) => entry.patch).length,
                maxPatchBytes: Math.max(...entries.filter((entry) => entry.patch).map((entry) => bytes(entry.patch))),
                summaryBasesKept: entries.filter((entry) => entry.summaryBase).length,
                optionalPayloadBytes: payloads.reduce((sum, payload) => sum + bytes(payload), 0),
                applyIncludingSerializeMs: round(applyMs),
                serializeMs: round(serializeMs),
            },
        };
    } finally {
        entriesStore.close();
    }
}

let begin;
const ready = new Promise((r) => (begin = r));
const runs = [];
const jobs = createGenerationJobs({
    store,
    kinds,
    gate: snapshots.gate,
    snapshots,
    lock,
    authorize: async () => true,
    runner: async (job) => {
        await ready;
        const { characterId, chatId } = job.context;
        const scope = loadJobScope(store, kinds, job.context);

        // The runner's `writeOwn`, call for call, with each call timed and its reads attributed.
        const writeOwn = (ops, covers) => {
            const t = {};
            let start = performance.now();
            phase = "scopeBefore";
            flushChatMetadata(job);
            refreshChat(store, scope);
            t.scopeBeforeMs = performance.now() - start;

            start = performance.now();
            phase = "write";
            const applied = job.write(
                () => ({
                    chats: [{ characterId, chatId, baseRevision: scope.chatRevision, ops }],
                }),
                covers ? { covers } : undefined,
            );
            t.writeMs = performance.now() - start;

            start = performance.now();
            phase = "scopeAfter";
            refreshChatAfterWrite(store, scope, applied.chats[0], applied.written?.chats[0]);
            t.scopeAfterMs = performance.now() - start;

            // Time inside the store's chat reads, measured only while emitRecords runs.
            let readMs = 0;
            const { readRefs, chatMeta } = store;
            const timed = (method) =>
                function (...args) {
                    const at = performance.now();
                    try {
                        return Reflect.apply(method, this, args);
                    } finally {
                        readMs += performance.now() - at;
                    }
                };
            store.readRefs = timed(readRefs);
            store.chatMeta = timed(chatMeta);
            start = performance.now();
            phase = "emit";
            try {
                job.emitRecords({ chats: [{ characterId, id: chatId }] });
            } finally {
                t.emitMs = performance.now() - start;
                store.readRefs = readRefs;
                store.chatMeta = chatMeta;
                phase = "other";
            }
            t.readMs = readMs;
            return { applied, t };
        };

        // The reply, appended and begun as the runner does before its stream (unmeasured).
        const generationId = randomUUID();
        const messageId = generationId;
        writeOwn([
            {
                op: "append",
                messages: [{ role: "char", data: "", saying: "c", time: Date.now(), chatId: messageId }],
                anchor: { end: true },
            },
            { op: "begin", id: messageId, generationId },
        ]);
        job.emit({ type: "accepted", jobId: job.id, messageId, generationId, revision: scope.chatRevision, text: "" });
        await settle();
        chatFrames.length = 0;

        let seq = 0;
        for (let run = 0; run < RUNS; run++) {
            globalThis.gc?.();
            for (const key of Object.keys(reads)) delete reads[key];
            lastChange = null;
            seq += 1;
            const text = `${run}:`.padEnd(REPLY_CHARS, String.fromCharCode(97 + run));
            const { applied, t } = writeOwn(
                [{ op: "setText", id: messageId, text, generation: { id: generationId, seq } }],
                [{ messageId, generationId, seq }],
            );
            const outcome = applied.chats[0]?.checkpoints?.at(-1);
            if (outcome !== "applied") throw new Error(`checkpoint ${run} was ${outcome}`);
            const runReads = { ...reads };
            const frame = await nextChatFrame();
            if (frame.type !== "chatPatch") throw new Error(`checkpoint ${run} sent a ${frame.type} frame`);
            await settle();
            if (chatFrames.length > 0) throw new Error(`checkpoint ${run} sent ${chatFrames.length + 1} chat frames`);
            if (!lastChange) throw new Error(`checkpoint ${run} published no feed change`);
            const feedChat = lastChange.changes.chats.find((chat) => chat.characterId === "c" && chat.id === "k");
            if (!feedChat.patch) throw new Error(`checkpoint ${run} published no feed patch`);
            const scopeMs = t.scopeBeforeMs + t.scopeAfterMs;
            const wholeTranscriptReads = {
                write: runReads.write ?? 0,
                scopeBefore: runReads.scopeBefore ?? 0,
                scopeAfter: runReads.scopeAfter ?? 0,
                emit: runReads.emit ?? 0,
            };
            wholeTranscriptReads.total = Object.values(wholeTranscriptReads).reduce((a, b) => a + b, 0);
            runs.push({
                writeMs: round(t.writeMs),
                scopeMs: round(scopeMs),
                scopeBeforeMs: round(t.scopeBeforeMs),
                scopeAfterMs: round(t.scopeAfterMs),
                emitMs: round(t.emitMs),
                readMs: round(t.readMs),
                baselineMs: round(t.emitMs - t.readMs),
                totalMs: round(t.writeMs + scopeMs + t.emitMs),
                ownerPatchBytes: frame.bytes,
                feedPatchBytes: bytes(feedChat.patch),
                feedEventBytes: bytes(lastChange),
                wholeTranscriptReads,
            });
        }

        // The final write, as the runner's `finalize` of a streamed reply (unmeasured).
        seq += 1;
        writeOwn(
            [
                {
                    op: "setText",
                    id: messageId,
                    text: "final",
                    generation: { id: generationId, seq, final: true },
                },
            ],
            [{ messageId, generationId, seq }],
        );
        job.emit({ type: "done", revision: store.chatRevision("c", "k") });
    },
});
const server = createServer();
server.on("upgrade", (req, socket, head) => jobs.handleUpgrade(req, socket, head));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const created = jobs.create(
    {
        clientId: "probe",
        kind: "send",
        context: {
            characterId: "c",
            chatId: "k",
            ...bound,
            mode: "normal",
            input: "",
            chatRevision: store.chatRevision("c", "k"),
        },
        hooks: NO_GENERATION_HOOKS,
    },
    store.epoch(),
);
if (!created.ok) throw new Error(JSON.stringify(created));
let ws;
try {
    ws = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/api/generations/${created.jobId}/ws?clientId=probe&attach=1`,
    );
    let attached = false;
    const terminal = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("probe cap: 120 seconds")), 120000);
        ws.on("error", reject);
        ws.on("message", (raw) => {
            const event = JSON.parse(String(raw));
            if (event.type === "chatPatch" || (event.type === "resource" && event.kind === "chats")) {
                if (!attached) {
                    // The attach's own copy of the chat: the checkpoints start after it.
                    attached = true;
                    begin();
                    return;
                }
                const frame = { type: event.type, bytes: raw.length };
                if (frameWaiter) {
                    const waiter = frameWaiter;
                    frameWaiter = null;
                    waiter(frame);
                } else {
                    chatFrames.push(frame);
                }
            }
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                resolve(event);
            }
        });
    });
    if (terminal.type !== "done") throw new Error(`the job ended with ${JSON.stringify(terminal)}`);
    if (runs.length !== RUNS) throw new Error(`${runs.length} of ${RUNS} checkpoints ran`);
    const phases = ["writeMs", "scopeMs", "scopeBeforeMs", "scopeAfterMs", "emitMs", "readMs", "baselineMs", "totalMs"];
    console.log(
        JSON.stringify(
            {
                label: "checkpoint-phases-5000-messages",
                commit: commitOf(),
                node: process.version,
                fixture: {
                    messages: MESSAGES,
                    messageDataChars: `${MESSAGES - 1}:`.length + MESSAGE_FILL,
                    replyTextChars: REPLY_CHARS,
                    runs: RUNS,
                    gcBeforeEachRun: typeof globalThis.gc === "function",
                },
                terminal: terminal.type,
                medians: Object.fromEntries(phases.map((name) => [name, round(median(runs.map((run) => run[name])))])),
                firstTotalMs: runs[0].totalMs,
                runs,
            },
            null,
            2,
        ),
    );
    console.log(JSON.stringify(measureFeedEntries()));
} finally {
    ws?.terminate();
    jobs.beginShutdown();
    await jobs.drain();
    jobs.dispose();
    await snapshots.stop();
    store.close();
    await new Promise((r) => server.close(r));
    rmSync(scratch, { recursive: true, force: true });
}
