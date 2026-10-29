// Traffic of a send's script callback barriers over the real job socket (audit finding TJ04): a 500-message chat
// of about 2 KiB each, a no-op `editprocess` hook, and 500 callbacks answered immediately.
//
// Run from the repository root: `node docs/research/deep-audit-with-fable/probes/job-channel-probe.mjs`.
// `PROBE_COMMIT` names the measured commit in the output; otherwise `git rev-parse HEAD` of this file's tree,
// else "unknown". Frame bytes are the WebSocket payload lengths: every frame received (`allFrameBytes`), the
// whole-chat `resource` frames, the `chatPatch` frames, and the `callback` frames, and the `answer` frames sent.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { createKindRegistry, DEFAULT_RESOURCE_KINDS } from "../../../../server/src/data/kinds.ts";
import { createResourceStore } from "../../../../server/src/data/resourceStore.ts";
import { createSnapshotManager } from "../../../../server/src/data/snapshots.ts";
import { createGenerationJobs } from "../../../../server/src/jobs/generationJobs.ts";
import { createGenerationLock } from "../../../../server/src/jobs/generationLock.ts";
import { NO_GENERATION_HOOKS } from "../../../../shared/jobs.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const MESSAGES = 500;
const MESSAGE_FILL = 2048;
const CALLBACKS = 500;
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
const scratch = mkdtempSync(path.join(tmpdir(), "risu-channel-probe-"));
const kinds = createKindRegistry(DEFAULT_RESOURCE_KINDS),
    lock = createGenerationLock();
const store = createResourceStore({ file: ":memory:", kinds, guard: lock });
const snapshots = createSnapshotManager({ store, dir: scratch + "/channel-snapshots" });
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
let begin;
const ready = new Promise((r) => (begin = r));
const jobs = createGenerationJobs({
    store,
    kinds,
    gate: snapshots.gate,
    snapshots,
    lock,
    authorize: async () => true,
    runner: async (job) => {
        await ready;
        for (let i = 0; i < CALLBACKS; i++) {
            const reply = await job.channel.callback("editprocess", { text: "unchanged" });
            if (reply.outcome !== "answered") throw new Error(JSON.stringify(reply));
        }
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
        hooks: { ...NO_GENERATION_HOOKS, scripts: ["editprocess"] },
    },
    store.epoch(),
);
if (!created.ok) throw new Error(JSON.stringify(created));
let ws;
try {
    ws = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/api/generations/${created.jobId}/ws?clientId=probe&attach=1`,
    );
    let bytes = 0,
        chats = 0,
        callbacks = 0,
        allFrames = 0,
        allFrameBytes = 0,
        chatPatchFrames = 0,
        chatPatchBytes = 0,
        callbackBytes = 0,
        answerBytes = 0;
    const start = performance.now();
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("probe cap: 20 seconds")), 20000);
        ws.on("error", reject);
        ws.on("message", (raw) => {
            allFrames++;
            allFrameBytes += raw.length;
            const event = JSON.parse(String(raw));
            if (event.type === "resource" && event.kind === "chats") {
                bytes += raw.length;
                chats++;
            }
            if (event.type === "chatPatch") {
                chatPatchFrames++;
                chatPatchBytes += raw.length;
            }
            if (event.type === "chatPatch" && callbacks === 0) begin();
            if (event.type === "callback") {
                callbacks++;
                callbackBytes += raw.length;
                const answer = JSON.stringify({
                    type: "answer",
                    id: event.id,
                    outcome: "answered",
                    value: "unchanged",
                });
                answerBytes += Buffer.byteLength(answer, "utf8");
                ws.send(answer);
            }
            if (event.type === "done" || event.type === "error") {
                clearTimeout(timer);
                console.log(
                    JSON.stringify({
                        label: "actual-job-socket-500-callbacks",
                        commit: commitOf(),
                        node: process.version,
                        fixture: {
                            messages: MESSAGES,
                            messageDataChars: `${MESSAGES - 1}:`.length + MESSAGE_FILL,
                            hook: "editprocess",
                            callbacks: CALLBACKS,
                        },
                        terminal: event.type,
                        callbacks,
                        wholeChatFrames: chats,
                        wholeChatBytes: bytes,
                        allFrames,
                        allFrameBytes,
                        chatPatchFrames,
                        chatPatchBytes,
                        callbackBytes,
                        answerBytes,
                        ms: +(performance.now() - start).toFixed(2),
                    }),
                );
                resolve();
            }
        });
    });
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
