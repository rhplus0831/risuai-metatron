// Restart races against the real self-host server and two independent browser clients.
// R1 committed batch, answer dropped by SIGKILL: persisted group replay changes no revision.
// R2 batch cut before commit: the same group retries once after SIGKILL, without losing local work.
// R3 write during graceful shutdown: a real 503 Retry-After is retried after SIGTERM.
// R4 SIGKILL mid-generation: the observer retains the checkpoint and can edit after its new hello;
// the owner receives the shutdown job error, with one reply and no restore/reload notice.
// R5 writes before event sockets reconnect: independent record fields merge and a message survives.
// Every case reads server records/chats, checks all chat membership and predicted message contents,
// then polls both module mirrors, notices and drafts (45 s deadline; no sleeps as synchronization).
// Usage: node util/playwright/checkServerRestartRaces.mjs
// Options: SERVER_PORT=6268 VITE_PORT=5368 RISU_CHROME=/usr/bin/google-chrome DEBUG=1.
// Dev-only: imports the app's module instances through Vite. Not run under offline.sh; no plugin.
// The temporary --import preload holds an HTTP request until SIGTERM, without changing app code.
// Custom NODE_OPTIONS replaces stack.mjs's guard, so the preload also guards fetch and writes
// denied-egress.log in the same temporary workDir. All restarts retain that stack's save/.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
import {
    chromePath,
    clearSafeBootAttempts,
    isolateContext,
    openApp,
    openCharacterChat,
    startStack,
    unexpectedEgress,
} from "./stack.mjs";

const TIMEOUT = 45_000;
const KNOWN_FAILURES = new Map();
const names = [
    "R1 committed batch, answer dropped by SIGKILL",
    "R2 batch cut before commit",
    "R3 write during graceful shutdown",
    "R4 SIGKILL mid-generation with an observer",
    "R5 writes before event sockets reconnect",
];
class HarnessError extends Error {}
async function until(label, read, accepts = Boolean) {
    let last;
    for (const deadline = Date.now() + TIMEOUT; Date.now() < deadline;) {
        last = await read();
        if (accepts(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new HarnessError(`${label}: ${TIMEOUT} ms deadline; last=${JSON.stringify(last)}`);
}
async function freePort(port) {
    const listener = createServer();
    await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, resolve);
    });
    await new Promise((resolve) => listener.close(resolve));
}
const same = (a, b) => {
    try {
        assert.deepEqual(a, b);
        return true;
    } catch {
        return false;
    }
};
const projectMessage = ({ chatId, role, data }) => ({ chatId, role, data });
const projectChat = (chat) => ({
    id: chat.id,
    name: chat.name,
    note: chat.note,
    modelPresetId: chat.modelPresetId,
    promptPresetId: chat.promptPresetId,
    bindedPersona: chat.bindedPersona,
    message: chat.message.map(projectMessage),
});
const projectCharacter = ({ chaId, name, desc, notes }) => ({ chaId, name, desc, notes });
const blank = (chaId) => ({
    chaId,
    type: "character",
    name: "Restart race character",
    desc: "Original description",
    notes: "Original notes",
    firstMessage: "",
    chatFolders: [],
    emotionImages: [],
    bias: [],
    viewScreen: "none",
    globalLore: [],
    utilityBot: false,
    customscript: [],
    exampleMessage: "",
    creatorNotes: "",
    systemPrompt: "",
    postHistoryInstructions: "",
    alternateGreetings: [],
    tags: [],
    creator: "",
    characterVersion: "",
    personality: "",
    scenario: "",
    firstMsgIndex: -1,
    replaceGlobalNote: "",
    triggerscript: [],
});

let stack;
let browser;
let provider;
let temporary;
let releaseProvider = () => {};
let cleanupPromise;
const clients = [];
const blocked = [];
const log = [];
const results = [];
let activeCase = "setup";
async function cleanup() {
    cleanupPromise ??= (async () => {
        releaseProvider();
        try {
            await browser?.close();
        } finally {
            try {
                await stack?.stop();
            } finally {
                if (provider) {
                    provider.closeAllConnections();
                    await new Promise((resolve) => provider.close(resolve));
                }
                if (temporary) await rm(temporary, { recursive: true, force: true });
            }
        }
    })();
    return cleanupPromise;
}
for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
]) {
    process.once(signal, () => {
        process.exitCode = code;
        void cleanup().catch((error) => console.error(error));
    });
}
// Event callbacks can fail outside the main try/finally; they must still close this stack.
for (const event of ["uncaughtException", "unhandledRejection"]) {
    process.once(event, (error) => {
        check(activeCase, error);
        process.exitCode = 1;
        void cleanup().finally(() => process.exit(1));
    });
}
function check(name, error) {
    const detail = error?.stack ?? String(error);
    const known = !(error instanceof HarnessError) && KNOWN_FAILURES.get(name);
    const status = !error ? "PASS" : known ? "KNOWN" : "FAIL";
    results.push(status);
    console.log(`${status} ${name}${error ? ` ${known ? `${known}: ` : ""}${detail}` : ""}`);
}

try {
    const serverPort = Number(process.env.SERVER_PORT ?? 6268);
    const vitePort = Number(process.env.VITE_PORT ?? 5368);
    await Promise.all([freePort(serverPort), freePort(vitePort)]);
    temporary = await mkdtemp(path.join(os.tmpdir(), "risu-restart-races-"));
    const preload = path.join(temporary, "preload.mjs");
    const armFile = path.join(temporary, "shutdown-arm");
    const heldFile = path.join(temporary, "shutdown-held.json");
    const answeredFile = path.join(temporary, "shutdown-answer.json");
    await writeFile(
        preload,
        `import { Server } from "node:http";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
const local = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.protocol === "data:" || url.protocol === "blob:" || local.has(url.hostname)) return realFetch(input, init);
    appendFileSync(path.join(process.cwd(), "denied-egress.log"), url.href + "\\n");
    throw new TypeError("egress denied by the check harness: " + url.origin);
};
const emit = Server.prototype.emit;
let held;
Server.prototype.emit = function(event, ...args) {
    if (event === "request" && args[0].method === "POST" && args[0].url === "/api/resources/batch" && existsSync(${JSON.stringify(armFile)})) {
        unlinkSync(${JSON.stringify(armFile)});
        held = { server: this, args };
        writeFileSync(${JSON.stringify(heldFile)}, JSON.stringify({ pid: process.pid, url: args[0].url }));
        return true;
    }
    return emit.call(this, event, ...args);
};
process.on("SIGTERM", () => {
    if (!held) return;
    // The application's signal listener sets shuttingDown synchronously; deliver on the next turn.
    setImmediate(() => {
        const { server, args } = held;
        held = null;
        args[1].on("finish", () => writeFileSync(${JSON.stringify(answeredFile)}, JSON.stringify({
            pid: process.pid, status: args[1].statusCode
        })));
        emit.call(server, "request", ...args);
    });
});
`,
    );
    const firstChunk = "Checkpointed first chunk.";
    const providerCalls = [];
    const heldStream = new Promise((resolve) => (releaseProvider = resolve));
    provider = http.createServer(async (req, res) => {
        try {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const call = { body, closed: false };
            providerCalls.push(call);
            res.on("close", () => (call.closed = true));
            if (!body.stream) {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Unused reply." } }] }));
                return;
            }
            res.writeHead(200, { "content-type": "text/event-stream" });
            const write = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            write(firstChunk);
            await heldStream;
            if (res.destroyed) return;
            write(" Released remainder.");
            res.end("data: [DONE]\n\n");
        } catch (error) {
            log.push(`Provider: ${error}`);
            res.destroy(error);
        }
    });
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    stack = await startStack({
        serverPort,
        vitePort,
        serverEnv: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
        log: (line) => {
            log.push(line);
            if (process.env.DEBUG) process.stderr.write(line);
        },
    });
    browser = await chromium.launch({ executablePath: chromePath, headless: true });

    async function forward(entry, deliver = true) {
        try {
            const response = await entry.route.fetch({ maxRetries: 0, timeout: TIMEOUT });
            entry.status = response.status();
            entry.headers = response.headers();
            entry.answer = await response.json();
            if (deliver) {
                await entry.route.fulfill({ response });
                entry.delivered = true;
            }
        } catch (error) {
            entry.transportError = String(error);
            await entry.route.abort("failed").catch(() => {});
        }
    }
    async function client(label) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        blocked.push(await isolateContext(context));
        await clearSafeBootAttempts(context);
        const page = await context.newPage();
        page.setDefaultTimeout(TIMEOUT);
        const c = { label, page, context, batches: [], hellos: [], reads: [], errors: [], jobs: [], hold: null };
        clients.push(c);
        page.on("pageerror", (error) => c.errors.push(String(error)));
        page.on("request", (req) => {
            const headers = req.headers();
            if (headers["risu-auth"]) c.auth = headers["risu-auth"];
            if (headers["x-resource-epoch"]) c.epoch = headers["x-resource-epoch"];
            const url = new URL(req.url());
            c.reads.push(url.pathname + url.search);
        });
        page.on("response", async (res) => {
            if (res.headers()["x-resource-epoch"]) c.epoch = res.headers()["x-resource-epoch"];
            if (res.request().method() === "POST" && new URL(res.url()).pathname === "/api/generations") {
                try {
                    c.jobs.push({
                        request: res.request().postDataJSON(),
                        status: res.status(),
                        body: await res.json(),
                    });
                } catch (error) {
                    c.errors.push(`Generation response: ${error}`);
                }
            }
        });
        // Playwright installs its socket interception in the document's init script. Register it
        // before navigation, then arm only future connections when a reconnect must be held.
        await page.routeWebSocket(
            (url) => url.pathname === "/api/events/ws",
            (socket) => {
                let closed = false;
                let server;
                socket.onClose((code, reason) => {
                    closed = true;
                    void server?.close({ code, reason }).catch((error) => {
                        if (!cleanupPromise) c.errors.push(`Socket close: ${error}`);
                    });
                });
                const connect = () => {
                    if (closed) return;
                    server = socket.connectToServer();
                    server.onMessage((message) => {
                        const frame = JSON.parse(String(message));
                        if (frame.type === "hello") c.hellos.push(frame);
                        socket.send(message);
                    });
                };
                if (c.socketGate) c.socketGate.push({ label: c.label, connect });
                else connect();
            },
        );
        await page.route("**/api/resources/batch", async (route) => {
            const entry = { route, body: route.request().postDataJSON() };
            c.batches.push(entry);
            const hold = c.hold;
            if (hold && hold.matches(entry.body)) {
                c.hold = null;
                if (hold.afterCommit) await forward(entry, false);
                hold.entry = entry;
                return;
            }
            await forward(entry);
        });
        c.api = async (url, body) => {
            const res = await fetch(stack.baseURL + url, {
                method: body === undefined ? "GET" : "POST",
                headers: { "risu-auth": c.auth, "x-resource-epoch": c.epoch, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: AbortSignal.timeout(TIMEOUT),
            });
            const data = await res.json();
            assert.equal(res.status, 200, `${url}: ${JSON.stringify(data)}`);
            if (data.epoch) c.epoch = data.epoch;
            return data;
        };
        return c;
    }
    const A = await client("A");
    await openApp(A.page, stack.baseURL);
    await A.page.evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).flushResources());
    await until(
        "setup writes and journal acknowledgements settled",
        () =>
            A.page.evaluate(async () => {
                const { resourceSyncIdle } = await import("/src/ts/storage/resourceSync.svelte.ts");
                const { pageDraftJournal } = await import("/src/ts/storage/draftJournal.ts");
                const journal = pageDraftJournal();
                return { idle: resourceSyncIdle(), enabled: journal.enabled, rows: await journal.readOwn() };
            }),
        (state) => state.idle && state.enabled && state.rows.length === 0,
    );
    await A.page.goto("about:blank");
    const records = Object.fromEntries(
        await Promise.all(
            ["ui", "presets", "modelPresets", "modelProfiles", "providers", "personas", "characterOrder"].map(
                async (kind) => [kind, await A.api(`/api/resources/${kind}/main`)],
            ),
        ),
    );
    const chaId = randomUUID();
    const chatIds = ["writes", "generation", "untouched"];
    const binding = chatBindingFixture(records.modelPresets, records.presets, records.personas);
    await A.api("/api/resources/batch", {
        ops: [
            ...modelFixtureOps(
                {
                    aiModel: "reverse_proxy",
                    forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
                    customProxyRequestModel: "mock",
                    customTokenizer: "tik",
                    maxContext: 4000,
                },
                records.modelPresets,
                records.modelProfiles,
            ),
            {
                kind: "ui",
                id: "main",
                baseRevision: records.ui.revision,
                data: {
                    ...records.ui.data,
                    didFirstSetup: true,
                    useSayNothing: false,
                    useAutoSuggestions: false,
                    language: "en",
                },
            },
            {
                kind: "providers",
                id: "main",
                baseRevision: records.providers.revision,
                data: { ...records.providers.data, useStreaming: true },
            },
            {
                kind: "presets",
                id: "main",
                baseRevision: records.presets.revision,
                data: [
                    promptFixture({ ...records.presets.data[0], mainPrompt: "Reply briefly.", maxResponse: 100 }),
                    ...records.presets.data.slice(1),
                ],
            },
            { kind: "characters", id: chaId, baseRevision: null, data: blank(chaId) },
            {
                kind: "characterOrder",
                id: "main",
                baseRevision: records.characterOrder.revision,
                data: [...records.characterOrder.data, chaId],
            },
        ],
        chats: chatIds.map((id) => ({
            characterId: chaId,
            chatId: id,
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: {
                        id,
                        name: id,
                        note: "",
                        localLore: [],
                        ...binding,
                        message: [1, 2].map((n) => ({
                            chatId: `${id}-m${n}`,
                            role: n === 1 ? "user" : "char",
                            data: `${id} original ${n}`,
                        })),
                    },
                },
            ],
        })),
    });
    const B = await client("B");
    for (const c of clients) {
        await openApp(c.page, stack.baseURL);
        await openCharacterChat(c.page, chaId);
        await c.page.evaluate(
            async ({ chaId, chatIds }) => {
                const chats = await import("/src/ts/storage/chatStore.svelte.ts");
                for (const chatId of chatIds) {
                    chats.pinChat({ chaId, chatId });
                    await chats.ensureChatLoaded({ chaId, chatId });
                }
                const { alertStore } = await import("/src/ts/stores.svelte.ts");
                const { terminalNotice, reloadNotice } = await import("/src/ts/alert.ts");
                const trace = (window.__restartTrace = { alerts: [], notices: [] });
                alertStore.subscribe((value) => {
                    if (value.type) trace.alerts.push(JSON.parse(JSON.stringify(value)));
                });
                for (const [kind, store] of [
                    ["terminal", terminalNotice],
                    ["reload", reloadNotice],
                ]) {
                    store.subscribe((message) => {
                        if (message) trace.notices.push({ kind, message });
                    });
                }
            },
            { chaId, chatIds },
        );
    }
    const serverChat = (id) =>
        A.api("/api/resources/read", { chats: [{ characterId: chaId, id }] }).then((body) => body.chats[0]);
    async function serverState() {
        const [character, body] = await Promise.all([
            A.api(`/api/resources/characters/${chaId}`),
            A.api("/api/resources/read", { chatCollections: [chaId] }),
        ]);
        const collection = body.chatCollections[0];
        return {
            character: projectCharacter(character.data),
            ids: collection.order.ids,
            chats: Object.fromEntries(collection.chats.map((chat) => [chat.id, projectChat(chat.data)])),
        };
    }
    const expected = await serverState();
    async function mirror(c) {
        return c.page.evaluate(async (chaId) => {
            const { findCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
            const { chatList, findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
            const { resourceSyncIdle, refusedItems } = await import("/src/ts/storage/resourceSync.svelte.ts");
            const { liveFeedCurrent } = await import("/src/ts/network/eventFeed.ts");
            const { recoveryDrafts } = await import("/src/ts/storage/recoveryDrafts.svelte.ts");
            const { chaId: id, name, desc, notes } = findCharacter(chaId);
            const ids = chatList(chaId).map((entry) => entry.id);
            const chats = Object.fromEntries(
                ids.map((chatId) => {
                    const chat = findChat({ chaId, chatId });
                    return [
                        chatId,
                        chat
                            ? {
                                  id: chat.id,
                                  name: chat.name,
                                  note: chat.note,
                                  modelPresetId: chat.modelPresetId,
                                  promptPresetId: chat.promptPresetId,
                                  bindedPersona: chat.bindedPersona,
                                  message: chat.message.map(({ chatId, role, data }) => ({ chatId, role, data })),
                              }
                            : null,
                    ];
                }),
            );
            return JSON.parse(
                JSON.stringify({
                    state: { character: { chaId: id, name, desc, notes }, ids, chats },
                    idle: resourceSyncIdle(),
                    current: liveFeedCurrent(),
                    refused: refusedItems(),
                    drafts: recoveryDrafts.entries,
                    ...window.__restartTrace,
                }),
            );
        }, chaId);
    }
    async function settle(c) {
        await until(
            `${c.label} save loop idle`,
            () => mirror(c),
            (state) => state.idle,
        );
    }
    let expectedJobId;
    const localMessages = new Map();
    const localFields = new Map();
    async function invariant() {
        for (const c of clients) await settle(c);
        const stored = await serverState();
        assert.deepEqual(stored, expected, "server differs from the cumulative accepted writes");
        assert.deepEqual([...stored.ids].sort(), [...chatIds].sort(), "a chat disappeared from the character");
        for (const { chatId, id, text } of localMessages.values()) {
            assert.equal(
                stored.chats[chatId].message.find((message) => message.chatId === id)?.data,
                text,
                "local message intent must reach the server",
            );
        }
        for (const [field, value] of localFields) {
            assert.equal(stored.character[field], value, "local record intent must reach the server");
        }
        for (const c of clients) {
            await until(
                `${c.label} mirror convergence`,
                () => mirror(c),
                (state) => state.idle && state.current && same(state.state, stored),
            );
            await c.page.evaluate(async () =>
                (await import("/src/ts/storage/recoveryDrafts.svelte.ts")).recoveryDrafts.refresh(),
            );
            const observed = await mirror(c);
            assert.deepEqual(observed.notices, [], `${c.label} restore/reload notice`);
            assert.deepEqual(observed.drafts, [], `${c.label} recovery draft`);
            assert.deepEqual(observed.refused, [], `${c.label} quarantined work`);
            const alerts = observed.alerts.filter((alert) => !["wait", "none"].includes(alert.type));
            assert(
                alerts.every(
                    (alert) =>
                        c === A &&
                        expectedJobId &&
                        alert.type === "error" &&
                        alert.jobFailure?.jobId === expectedJobId &&
                        alert.jobFailure?.end.reason === "shutdown",
                ),
                `${c.label} unexpected alerts: ${JSON.stringify(alerts)}`,
            );
            assert.deepEqual(c.errors, [], `${c.label} page errors`);
        }
    }
    function hold(c, matches, afterCommit = false) {
        assert.equal(c.hold, null);
        const gate = { matches, afterCommit };
        c.hold = gate;
        return gate;
    }
    const forChat = (id) => (body) => body.chats?.some((group) => group.chatId === id);
    const groupOf = (entry, id = "writes") => entry.body.chats.find((group) => group.chatId === id);
    const resultOf = (entry, id = "writes") => entry.answer.chats.find((group) => group.id === id);
    async function edit(c, { text, id = "writes-m1", chatId = "writes", append, patch }) {
        await c.page.evaluate(
            async ({ chaId, chatId, id, text, append, patch }) => {
                const { setMessageText, appendMessage } = await import("/src/ts/storage/chatStore.svelte.ts");
                const { updateCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
                if (text !== undefined) setMessageText({ chaId, chatId }, id, text);
                if (append) appendMessage({ chaId, chatId }, append);
                if (patch && !updateCharacter(chaId, patch)) throw new Error("Character missing");
            },
            { chaId, chatId, id, text, append, patch },
        );
        if (text !== undefined) localMessages.set(`${chatId}/${id}`, { chatId, id, text });
        if (append) localMessages.set(`${chatId}/${append.chatId}`, { chatId, id: append.chatId, text: append.data });
        for (const [field, value] of Object.entries(patch ?? {})) localFields.set(field, value);
    }
    function predict(entry, chatId = "writes") {
        assert.equal(entry.status, 200, JSON.stringify(entry.answer));
        for (const op of groupOf(entry, chatId).ops) {
            if (op.op === "setText") {
                const message = expected.chats[chatId].message.find((message) => message.chatId === op.id);
                assert(message, "accepted text op targets an expected message");
                message.data = op.text;
            } else if (op.op === "append") {
                assert.deepEqual(op.anchor, { end: true });
                expected.chats[chatId].message.push(...op.messages.map(projectMessage));
            } else throw new HarnessError(`Unexpected accepted op: ${JSON.stringify(op)}`);
        }
    }
    function requireReplay(first, retry) {
        const group = groupOf(first);
        assert(group.groupId, "original group has an identity");
        assert.deepEqual(groupOf(retry), { ...group, retry: true }, "retry preserves the group, base and operations");
        assert.equal(retry.status, 200, JSON.stringify(retry.answer));
    }
    async function run(name, fn) {
        activeCase = name;
        try {
            await fn();
            await invariant();
            check(name);
        } catch (error) {
            check(name, error);
            if (!KNOWN_FAILURES.has(name) || error instanceof HarnessError) throw error;
        }
    }
    await invariant();

    await run(names[0], async () => {
        const start = A.batches.length;
        const gate = hold(A, forChat("writes"), true);
        await edit(A, {
            text: "Committed before the crash",
            append: { chatId: "committed-append", role: "user", data: "Appended exactly once" },
        });
        const first = await until("committed answer held", () => gate.entry);
        assert.equal(first.status, 200, JSON.stringify(first.answer));
        assert.deepEqual(
            groupOf(first)
                .ops.map((op) => op.op)
                .sort(),
            ["append", "setText"],
        );
        const committedRevision = resultOf(first).revision;
        predict(first);
        await stack.restartServer({ signal: "SIGKILL" });
        assert.deepEqual(await serverState(), expected, "commit survives SIGKILL before the browser gets the answer");
        assert.equal((await serverChat("writes")).revision, committedRevision);
        await first.route.abort("failed");
        const retry = await until("same-group replay answered", () =>
            A.batches.slice(start + 1).find((entry) => forChat("writes")(entry.body) && entry.delivered),
        );
        requireReplay(first, retry);
        assert.deepEqual(resultOf(retry), resultOf(first), "persisted receipt returns the original result");
        await settle(A);
        assert.equal(
            (await serverChat("writes")).revision,
            committedRevision,
            "replayed setText must not bump the revision",
        );
        assert.equal(A.batches.slice(start).filter((entry) => forChat("writes")(entry.body)).length, 2);
        console.log(`INFO R1 original/replay revision ${committedRevision}; same groupId, base, ops; retry=true`);
    });

    await run(names[1], async () => {
        const start = A.batches.length;
        const before = await serverChat("writes");
        const gate = hold(A, forChat("writes"));
        await edit(A, { text: "Uncommitted edit retried after restart", id: "writes-m2" });
        const first = await until("unforwarded batch held", () => gate.entry);
        await stack.restartServer({ signal: "SIGKILL" });
        assert.deepEqual(await serverState(), expected, "held request must not have committed");
        assert.equal((await serverChat("writes")).revision, before.revision);
        await first.route.abort("failed");
        const retry = await until("uncommitted group retry answered", () =>
            A.batches.slice(start + 1).find((entry) => forChat("writes")(entry.body) && entry.delivered),
        );
        requireReplay(first, retry);
        predict(retry);
        await settle(A);
        assert.equal((await serverChat("writes")).revision, resultOf(retry).revision);
        assert.equal(A.batches.slice(start).filter((entry) => forChat("writes")(entry.body)).length, 2);
    });

    await run(names[2], async () => {
        const start = A.batches.length;
        await writeFile(armFile, "hold the next batch");
        await edit(A, { text: "Edit retried after a real shutdown refusal", id: "writes-m2" });
        const held = JSON.parse(
            await until("HTTP request captured inside the server", () => readFile(heldFile, "utf8").catch(() => null)),
        );
        await stack.restartServer({ signal: "SIGTERM" });
        const proof = JSON.parse(await readFile(answeredFile, "utf8"));
        assert.equal(proof.pid, held.pid, "the old process answered the captured request");
        assert.equal(proof.status, 503);
        const refused = await until("shutdown answer delivered to the browser", () =>
            A.batches.slice(start).find((entry) => entry.status === 503 && entry.delivered),
        );
        assert.equal(refused.headers["retry-after"], "5");
        assert.deepEqual(refused.answer, { error: "The server is shutting down" });
        const retry = await until("save loop retries shutdown refusal", () =>
            A.batches
                .slice(start)
                .find((entry) => entry.status === 200 && entry.delivered && forChat("writes")(entry.body)),
        );
        requireReplay(refused, retry);
        predict(retry);
        console.log(
            `INFO R3 real HTTP ${refused.status}, Retry-After=${refused.headers["retry-after"]}, body=${JSON.stringify(refused.answer)}; batch statuses=${JSON.stringify(A.batches.slice(start).map((entry) => entry.status ?? "network failure"))}`,
        );
    });

    await run(names[3], async () => {
        for (const c of clients) {
            await c.page.evaluate(async () => (await import("/src/ts/globalApi.svelte.ts")).changeChatTo("generation"));
            await c.page.locator("textarea.input-text").first().waitFor();
        }
        const prompt = "Hold this generation across a server crash.";
        const input = A.page.locator("textarea.input-text").first();
        await input.fill(prompt);
        await input.press("Enter");
        await until(
            "held streaming provider call",
            () => providerCalls.filter((call) => call.body.stream).length,
            (count) => count === 1,
        );
        const job = await until("generation accepted", () =>
            A.jobs.find((job) => job.status === 200 || job.status === 201),
        );
        expectedJobId = job.body.jobId;
        assert(expectedJobId, JSON.stringify(job));
        const reply = await until(
            "observer has the checkpoint reply",
            () => mirror(B),
            (state) => state.state.chats.generation.message.at(-1)?.data === firstChunk,
        );
        const messages = reply.state.chats.generation.message;
        await until(
            "observer renders the first chunk",
            () => B.page.locator(".chattext").allTextContents(),
            (texts) => texts.some((text) => text.includes(firstChunk)),
        );
        assert.equal(messages.length, expected.chats.generation.message.length + 2);
        assert.deepEqual(messages.slice(0, -2), expected.chats.generation.message);
        assert.equal(messages.at(-2).role, "user");
        assert.equal(messages.at(-2).data, prompt);
        assert.equal(messages.at(-1).role, "char");
        const replyId = messages.at(-1).chatId;
        const locked = (c) =>
            c.page.evaluate(
                async ({ chaId, replyId }) =>
                    (await import("/src/ts/storage/chatStore.svelte.ts")).isMessageLocked(
                        { chaId, chatId: "generation" },
                        replyId,
                    ),
                { chaId, replyId },
            );
        await until("observer sees the generation lock", () => locked(B));
        const checkpoint = await until(
            "first chunk committed to SQLite",
            () => serverChat("generation"),
            (chat) => chat.data.message.at(-1)?.data === firstChunk,
        );
        expected.chats.generation.message = messages;
        assert.deepEqual(projectChat(checkpoint.data), expected.chats.generation);
        const helloStart = B.hellos.length;
        const epoch = A.epoch;
        await stack.restartServer({ signal: "SIGKILL" });
        releaseProvider();
        assert.equal(A.epoch, epoch, "restart must retain the epoch");
        assert.deepEqual(
            projectChat((await serverChat("generation")).data),
            expected.chats.generation,
            "restart retains exactly the last checkpoint",
        );
        const failure = await until(
            "owner receives shutdown job error",
            () => mirror(A),
            (state) =>
                state.alerts.some(
                    (alert) =>
                        alert.type === "error" &&
                        alert.jobFailure?.jobId === expectedJobId &&
                        alert.jobFailure?.end.reason === "shutdown",
                ),
        );
        assert.deepEqual(failure.notices, []);
        await until(
            "owner send ended",
            () => A.page.locator('button[aria-labelledby="cancel"]').count(),
            (count) => count === 0,
        );
        await until("observer's new same-epoch hello", () =>
            B.hellos.slice(helloStart).some((hello) => hello.epoch === epoch),
        );
        await until(
            "new hello clears observer's lock",
            () => locked(B),
            (value) => value === false,
        );
        await invariant();
        const start = B.batches.length;
        await edit(B, { chatId: "generation", id: replyId, text: "Observer edited the checkpoint after restart" });
        const accepted = await until("observer reply edit accepted", () =>
            B.batches
                .slice(start)
                .find((entry) => entry.status === 200 && entry.delivered && forChat("generation")(entry.body)),
        );
        predict(accepted, "generation");
        assert.equal(providerCalls.filter((call) => call.body.stream).length, 1, "generation is not restarted");
        console.log(`INFO R4 shutdown job error; same epoch; new observer hello cleared the lock; reply=${replyId}`);
    });

    await run(names[4], async () => {
        const gates = [];
        const starts = clients.map((c) => ({
            batches: c.batches.length,
            hellos: c.hellos.length,
            reads: c.reads.length,
        }));
        for (const c of clients) c.socketGate = gates;
        await stack.restartServer({ signal: "SIGKILL" });
        const hasCharacter = (body) => body.ops?.some((op) => op.kind === "characters" && op.id === chaId);
        const heldA = hold(A, hasCharacter);
        const heldB = hold(B, hasCharacter);
        await edit(A, { patch: { name: "Name edited by A after restart" } });
        await edit(B, {
            patch: { desc: "Description edited by B after restart" },
            text: "Message retained through record conflict",
        });
        const firstA = await until("A's stale character batch held", () => heldA.entry);
        const firstB = await until("B's stale character and message batch held", () => heldB.entry);
        const charOp = (entry) => entry.body.ops.find((op) => op.kind === "characters" && op.id === chaId);
        const applyCharacter = (entry, base) => {
            const op = charOp(entry);
            if (op.data) return projectCharacter(op.data);
            assert(op.patch?.set, `Expected a field patch: ${JSON.stringify(op)}`);
            assert.deepEqual(op.patch.remove ?? [], []);
            return projectCharacter({ ...base, ...op.patch.set });
        };
        const localB = applyCharacter(firstB, expected.character);
        assert.equal(
            charOp(firstA).baseRevision,
            charOp(firstB).baseRevision,
            "both writes must use the same stale record base",
        );
        assert(forChat("writes")(firstB.body), "B's message shares its stale record batch");
        for (const [i, c] of clients.entries())
            assert.equal(c.hellos.length, starts[i].hellos, "no new hello before the writes");
        await forward(firstA);
        assert.equal(firstA.status, 200);
        expected.character = applyCharacter(firstA, expected.character);
        await forward(firstB);
        assert.equal(firstB.status, 409, JSON.stringify(firstB.answer));
        const merged = await until("B's record merge and message retry accepted", () =>
            B.batches
                .slice(starts[1].batches + 1)
                .find((entry) => entry.status === 200 && entry.delivered && hasCharacter(entry.body)),
        );
        const mergedCharacter = applyCharacter(merged, expected.character);
        assert.equal(mergedCharacter.name, expected.character.name);
        assert.equal(mergedCharacter.desc, localB.desc);
        assert.equal(
            charOp(merged).baseRevision,
            firstA.answer.results.find((result) => result.kind === "characters" && result.id === chaId).revision,
            "merge rebases on A's accepted record",
        );
        expected.character = mergedCharacter;
        assert.deepEqual(groupOf(merged).ops, groupOf(firstB).ops, "rolled-back message survives record conflict");
        predict(merged);
        for (const c of clients) await settle(c);
        assert.deepEqual(await serverState(), expected, "both writes committed while event sockets are gated");
        for (const [i, c] of clients.entries()) {
            if (c.hellos.length !== starts[i].hellos || (await mirror(c)).current) {
                throw new HarnessError(`${c.label} event socket reconnected before the gate was released`);
            }
        }
        await until("both reconnect sockets held", () =>
            clients.every((c) => gates.some((gate) => gate.label === c.label)),
        );
        for (const c of clients) c.socketGate = null;
        for (const gate of gates) gate.connect();
        for (const [i, c] of clients.entries()) {
            await until(`${c.label} new hello after gate release`, () => c.hellos.length > starts[i].hellos);
            await until(
                `${c.label} hello reconciled`,
                () => mirror(c),
                (state) => state.current,
            );
            const reads = c.reads
                .slice(starts[i].reads)
                .filter((url) => /^\/api\/resources\/revisions(?:\?|$)/.test(url));
            console.log(
                `INFO R5 ${c.label} new hello reconciled; listing requests=${JSON.stringify(reads)}${reads.length ? "" : " (matching cached digest)"}`,
            );
        }
        console.log("INFO R5 same record base; A=200, B=409 then merged retry=200; message retained");
    });
    activeCase = "unexpected egress";
    assert.deepEqual(unexpectedEgress(blocked.flat(), await stack.deniedEgress()), []);
    check(activeCase);
} catch (error) {
    if (!results.includes("FAIL")) check(activeCase, error);
    if (process.env.DEBUG) console.error(log.slice(-30).join(""));
    process.exitCode = 1;
} finally {
    await cleanup();
}
if (results.includes("FAIL")) process.exitCode = 1;
