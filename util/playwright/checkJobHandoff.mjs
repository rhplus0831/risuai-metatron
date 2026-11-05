// Real-browser generation job handoffs with a sandboxed v3 plugin and a loopback streaming model.
// Usage: node util/playwright/checkJobHandoff.mjs
// Prefer: util/playwright/offline.sh node util/playwright/checkJobHandoff.mjs
// Optional: SERVER_PORT=6282 VITE_PORT=5382 DEBUG=1 (ports must be free).
// Production server deadlines are retained. Lost callbacks each wait their real 60 s allowance.
// Closing an app navigates the same page to about:blank; reopening retains its sessionStorage id
// and saved jobs. The mock holds the stream until the check releases it, independently of tabs.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
import {
    chromePath,
    isolateContext,
    openApp,
    openCharacterChat,
    pluginFixtureOp,
    startStack,
    unexpectedEgress,
} from "./stack.mjs";

const names = [
    "creator-closed-after-accepted",
    "creator-keeps-watching",
    "prefer-worker",
    "manual-handoff-by-name",
    "hidden-worker",
    "worker-closed-creator-takes-back",
    "pending-editoutput",
    "lost-body-interceptor",
    "missed-chat-output",
    "late-listener-without-owner",
];
const pluginName = "BrowserJobHandoff";
const marker = "handoff-listener:";
const initialNote = "Browser handoff fixture note.";
// Only the listener is registered at startup. Optional hooks are installed in both sandboxes
// before admission, so the job's frozen hook list matches the worker's real registry.
const pluginScript = `//@name ${pluginName}
//@api 3.0
const state = globalThis.__jobHandoff = { ready: false, tab: await risuai.safeLocalStorage.getItem("handoff-check-tab") ?? "unset", hold: null, calls: [] };
async function enter(kind, extra = {}) {
    const call = { kind, tab: state.tab, at: Date.now(), phase: "running", ...extra };
    state.calls.push(call);
    if (state.hold === kind) {
        call.phase = "held";
        await new Promise(resolve => call.release = resolve);
    }
    call.phase = "released";
    return call;
}
state.configure = async ({ tab, hold = null, edit = false, body = false }) => {
    state.tab = tab;
    await risuai.safeLocalStorage.setItem("handoff-check-tab", tab);
    state.hold = hold;
    if (edit) await risuai.addRisuScriptHandler("output", async text => {
        const call = await enter("editoutput");
        call.phase = "done";
        return text + " [editoutput:" + state.tab + "]";
    });
    if (body) await risuai.registerBodyIntercepter(async body => {
        const call = await enter("bodyIntercepter");
        call.phase = "done";
        return body;
    });
};
await risuai.addRisuChatListener("output", async ({ chat, characterIndex, chatIndex, messageIndex }) => {
    const messageId = chat.message[messageIndex]?.chatId;
    const call = await enter("chatOutput", { chatId: chat.id, messageId, characterIndex, chatIndex });
    try {
        const current = await risuai.getChatFromIndex(characterIndex, chatIndex);
        if (!current || current.id !== chat.id) throw new Error("Listener targeted a different chat");
        const message = current.message.find(row => row.chatId === messageId);
        if (!message) throw new Error("Listener's replied message is missing");
        // The reply stays locked throughout the tail. Chat metadata remains writable, and the
        // callback's mutation scope is flushed by the host before its socket answer is sent.
        current.note = (current.note ?? "") + "\\n${marker}" + JSON.stringify({ messageId, tab: state.tab });
        await risuai.setChatToIndex(characterIndex, chatIndex, current);
        call.phase = "done";
    } catch (error) {
        call.phase = "failed";
        call.error = String(error);
        throw error;
    }
});
state.ready = true;
`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, read, predicate = Boolean, timeout = 30_000) {
    let last;
    for (const end = Date.now() + timeout; Date.now() < end;) {
        last = await read();
        if (predicate(last)) return last;
        await delay(25);
    }
    throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}
async function freePort(port) {
    const listener = createServer();
    await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, resolve);
    });
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}

const providerCalls = [];
const provider = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const call = { body: JSON.parse(body), at: Date.now() };
    providerCalls.push(call);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (content) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
    call.chunk = chunk;
    chunk("Handoff reply streaming ");
    await new Promise((resolve) => (call.finish = resolve));
    if (res.destroyed) return;
    chunk("finished.");
    res.end("data: [DONE]\n\n");
});
let stack;
let browser;
const clients = [];
const blocked = [];
const serverLog = [];
const results = [];
const started = Date.now();
let activeCase = "setup";
let caseStarted = started;
let activeFixture;
try {
    const serverPort = Number(process.env.SERVER_PORT ?? 6282);
    const vitePort = Number(process.env.VITE_PORT ?? 5382);
    await Promise.all([freePort(serverPort), freePort(vitePort)]);
    await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
    stack = await startStack({
        serverPort,
        vitePort,
        log: (line) => {
            serverLog.push(line);
            if (process.env.DEBUG) process.stderr.write(line);
        },
    });
    browser = await chromium.launch({
        executablePath: chromePath,
        headless: true,
        // Keep Chrome's real background timer policy for the hidden-worker measurement.
        ignoreDefaultArgs: [
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
        ],
    });
    async function client(tab, accept) {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        blocked.push(await isolateContext(context));
        await context.addInitScript(
            ({ tab, accept }) => {
                if (window !== window.top || location.origin === "null") return;
                localStorage.removeItem("risu.safeBoot.attempts");
                for (const [key, value] of [
                    ["name", tab],
                    ["accept", accept],
                    ["prefer", false],
                ]) {
                    if (localStorage.getItem("risu-handoff-" + key) === null)
                        localStorage.setItem("risu-handoff-" + key, JSON.stringify(value));
                }
                window.__handoffToasts = [];
                window.__handoffVisibility = [{ at: Date.now(), state: document.visibilityState }];
                document.addEventListener("visibilitychange", () =>
                    window.__handoffVisibility.push({ at: Date.now(), state: document.visibilityState }),
                );
                new MutationObserver(() => {
                    for (const node of document.querySelectorAll(".toast-anime")) {
                        const text = node.textContent.trim();
                        if (window.__handoffToasts.at(-1) !== text) window.__handoffToasts.push(text);
                    }
                }).observe(document, { childList: true, subtree: true, characterData: true });
            },
            { tab, accept },
        );
        const page = await context.newPage();
        const c = {
            tab,
            context,
            page,
            auth: null,
            epoch: null,
            events: [],
            outgoing: [],
            feed: [],
            posts: [],
            errors: [],
        };
        clients.push(c);
        page.on("pageerror", (error) => c.errors.push(String(error)));
        page.on("request", (req) => {
            const headers = req.headers();
            if (headers["risu-auth"]) c.auth = headers["risu-auth"];
            if (headers["x-resource-epoch"]) c.epoch = headers["x-resource-epoch"];
            if (req.method() === "POST" && new URL(req.url()).pathname === "/api/generations")
                c.posts.push(req.postDataJSON());
        });
        page.on("response", (res) => {
            if (res.headers()["x-resource-epoch"]) c.epoch = res.headers()["x-resource-epoch"];
        });
        page.on("websocket", (socket) => {
            const job = socket.url().includes("/api/generations/");
            if (!job && !socket.url().includes("/api/events")) return;
            const jobId = job ? new URL(socket.url()).pathname.split("/").at(-2) : undefined;
            for (const [event, target] of [
                ["framereceived", job ? c.events : c.feed],
                ["framesent", c.outgoing],
            ]) {
                socket.on(event, ({ payload }) => {
                    try {
                        target.push({ at: Date.now(), jobId, ...JSON.parse(String(payload)) });
                    } catch {}
                });
            }
        });
        c.api = async (url, body) => {
            const response = await fetch(stack.baseURL + url, {
                method: body === undefined ? "GET" : "POST",
                headers: { "risu-auth": c.auth, "x-resource-epoch": c.epoch, "content-type": "application/json" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const data = await response.json().catch(() => null);
            if (data?.epoch) c.epoch = data.epoch;
            return { status: response.status, body: data };
        };
        await openApp(page, stack.baseURL);
        await until("authenticated request", () => c.auth);
        return c;
    }
    const A = await client("Handoff A", false);
    assert.deepEqual(
        await A.page.evaluate(async () => (await import("/src/ts/storage/resourceSync.svelte.ts")).flushResources()),
        { discarded: [], refused: [] },
    );
    async function single(kind) {
        const res = await A.api(`/api/resources/${kind}/main`);
        if (res.status === 404 && ["plugins", "pluginPermissions"].includes(kind))
            return { revision: null, data: kind === "plugins" ? [] : { grants: {}, lastGrantTime: {} } };
        assert.equal(res.status, 200, JSON.stringify(res));
        return res.body;
    }
    const records = Object.fromEntries(
        await Promise.all(
            [
                "ui",
                "presets",
                "modelPresets",
                "modelProfiles",
                "personas",
                "providers",
                "plugins",
                "pluginPermissions",
                "characterOrder",
            ].map(async (kind) => [kind, await single(kind)]),
        ),
    );
    const fixtures = [...names, "worker-other-chat"].map((name, index) => ({
        name,
        chaId: randomUUID(),
        chatId: randomUUID(),
        index,
    }));
    const hash = createHash("sha256").update(pluginScript).digest("hex");
    const preset = { ...records.presets.data[0], mainPrompt: "Reply briefly.", maxResponse: 100 };
    const seeded = await A.api("/api/resources/batch", {
        ops: [
            ...modelFixtureOps(
                {
                    aiModel: "reverse_proxy",
                    forceReplaceUrl: `http://127.0.0.1:${provider.address().port}/v1/chat/completions`,
                    customProxyRequestModel: "handoff-mock",
                    maxContext: 4000,
                    customTokenizer: "tik",
                },
                records.modelPresets,
                records.modelProfiles,
            ),
            {
                kind: "ui",
                id: "main",
                baseRevision: records.ui.revision,
                data: { ...records.ui.data, didFirstSetup: true, useSayNothing: false, language: "en" },
            },
            {
                kind: "presets",
                id: "main",
                baseRevision: records.presets.revision,
                data: [promptFixture(preset), ...records.presets.data.slice(1)],
            },
            {
                kind: "providers",
                id: "main",
                baseRevision: records.providers.revision,
                data: { ...records.providers.data, useStreaming: true, requestRetrys: 0 },
            },
            pluginFixtureOp(pluginName, pluginScript, records.plugins),
            {
                kind: "pluginPermissions",
                id: "main",
                baseRevision: records.pluginPermissions.revision,
                data: {
                    grants: { ...records.pluginPermissions.data.grants, [`${hash}_replacer`]: true },
                    lastGrantTime: {
                        ...records.pluginPermissions.data.lastGrantTime,
                        [`${pluginName}_replacer_lastGrantTime`]: Date.now(),
                    },
                },
            },
            ...fixtures.map((f) => ({
                kind: "characters",
                id: f.chaId,
                baseRevision: null,
                data: {
                    name: f.name,
                    chaId: f.chaId,
                    type: "character",
                    firstMessage: "Browser handoff fixture.",
                    desc: "",
                    notes: "",
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
                    triggerscript: [
                        {
                            comment: "Refresh the reply display",
                            type: "output",
                            conditions: [],
                            effect: [{ type: "triggerlua", code: "onOutput = function(id) reloadDisplay(id) end" }],
                        },
                    ],
                },
            })),
            {
                kind: "characterOrder",
                id: "main",
                baseRevision: records.characterOrder.revision,
                data: [...records.characterOrder.data, ...fixtures.map((f) => f.chaId)],
            },
        ],
        chats: fixtures.map((f) => ({
            characterId: f.chaId,
            chatId: f.chatId,
            baseRevision: null,
            ops: [
                {
                    op: "create",
                    chat: {
                        id: f.chatId,
                        name: "Handoff chat",
                        note: initialNote,
                        fmIndex: -1,
                        message: [],
                        ...chatBindingFixture(records.modelPresets, records.presets, records.personas),
                    },
                },
            ],
        })),
    });
    assert.equal(seeded.status, 200, JSON.stringify(seeded));
    await openApp(A.page, stack.baseURL);
    const B = await client("Handoff B", true);
    const language = await A.page.evaluate(async () =>
        JSON.parse(JSON.stringify((await import("/src/lang/index.ts")).language)),
    );
    async function sandbox(c) {
        return until(`${c.tab} plugin ready`, async () => {
            for (const frame of c.page.frames())
                if (await frame.evaluate(() => globalThis.__jobHandoff?.ready).catch(() => false)) return frame;
        });
    }
    async function configure(c, options = {}) {
        await (
            await sandbox(c)
        ).evaluate((options) => globalThis.__jobHandoff.configure(options), { tab: c === A ? "A" : "B", ...options });
    }
    async function calls(c) {
        return (await sandbox(c)).evaluate(() => globalThis.__jobHandoff.calls.map(({ release, ...call }) => call));
    }
    async function reopen(c, options = {}) {
        await openApp(c.page, stack.baseURL);
        await configure(c, options);
        const id = await c.page.evaluate(async () =>
            (await import("/src/ts/network/generationJobs.ts")).generationClientId(),
        );
        if (c.id) assert.equal(id, c.id, "App navigation changed the tab identity");
        c.id = id;
    }
    const close = (c) => c.page.goto("about:blank");
    const events = (c, f) => c.events.filter((event) => event.jobId === f.jobId);
    const callbacks = (c, f) => events(c, f).filter((event) => event.type === "callback");
    const role = (c, f, owner, pending = false) =>
        until(`${c.tab} ${pending ? "pending" : owner} role`, () =>
            events(c, f).find(
                (event) => event.type === "handoff" && event.owner === owner && !!event.pending === pending,
            ),
        );
    async function setup(index, options = {}) {
        const f = (activeFixture = fixtures[index]);
        await reopen(A, options.A);
        await reopen(B, options.B);
        assert.notEqual(A.id, B.id);
        await A.page.evaluate(async () => (await import("/src/ts/network/handoff.ts")).preferHandoff.set(false));
        await B.page.evaluate(async () => (await import("/src/ts/network/handoff.ts")).acceptHandoffs.set(true));
        await openCharacterChat(A.page, f.chaId);
        await openCharacterChat(B.page, fixtures.at(-1).chaId);
        await until("worker registered by name", () =>
            A.feed.some((event) =>
                (event.clients ?? []).some((c) => c.clientId === B.id && c.worker && c.name === B.tab),
            ),
        );
        f.providerIndex = providerCalls.length;
        f.eventIndex = A.events.length;
        f.began = Date.now();
        return f;
    }
    async function send(f) {
        f.began = Date.now();
        const input = A.page.locator("textarea.input-text").first();
        await input.fill(`Run ${f.name}.`);
        await input.press("Enter");
        const accepted = await until("accepted", () =>
            A.events.slice(f.eventIndex).find((event) => event.type === "accepted"),
        );
        f.jobId = accepted.jobId;
        return accepted;
    }
    const providerCall = (f) =>
        until("mock stream", () => providerCalls[f.providerIndex]?.finish && providerCalls[f.providerIndex]);
    async function finish(f) {
        (await providerCall(f)).finish();
    }
    async function status(f) {
        const res = await A.api(`/api/generations/${f.jobId}?clientId=${A.id}`);
        assert.equal(res.status, 200, JSON.stringify(res));
        return res.body;
    }
    const ended = (f) =>
        until(
            "job terminal",
            () => status(f),
            (value) => value.terminal,
            75_000,
        );
    async function readChat(f) {
        const res = await A.api("/api/resources/read", { chatCollections: [f.chaId] });
        assert.equal(res.status, 200, JSON.stringify(res));
        return res.body.chatCollections[0].chats.find((chat) => chat.id === f.chatId).data;
    }
    const messages = async (f) => (await readChat(f)).message;
    const markers = (chat) =>
        (chat.note ?? "")
            .split("\n")
            .filter((line) => line.startsWith(marker))
            .map((line) => JSON.parse(line.slice(marker.length)));
    async function marked(f, tab, count = 1) {
        const chat = await readChat(f);
        const rows = chat.message;
        const replies = rows.filter((row) => row.role === "char");
        assert.equal(replies.length, 1, JSON.stringify(rows));
        const text = replies[0].data;
        const entries = markers(chat);
        assert(chat.note.startsWith(initialNote), chat.note);
        assert.equal(entries.length, count, JSON.stringify(chat));
        if (count) assert.deepEqual(entries, [{ messageId: replies[0].chatId, tab }]);
        return text;
    }
    async function done(f, tab = "B") {
        const result = await ended(f);
        assert.equal(result.terminal.type, "done", JSON.stringify(result));
        assert.deepEqual(result.terminal.skipped ?? [], []);
        assert.deepEqual(result.terminal.missed ?? [], []);
        await marked(f, tab);
        const c = tab === "A" ? A : B;
        const recorded = (await calls(c)).filter((call) => call.kind === "chatOutput" && call.chatId === f.chatId);
        assert.equal(recorded.length, 1, JSON.stringify(recorded));
        assert.equal(recorded[0].phase, "done", JSON.stringify(recorded));
        return result;
    }
    async function request(f, target) {
        await A.page.evaluate(
            async ({ jobId, target }) => {
                await (await import("/src/ts/network/generationJobs.ts")).requestGenerationHandoff(jobId, target);
            },
            { jobId: f.jobId, target },
        );
    }
    async function manual(f) {
        await A.page.getByRole("button", { name: language.serverJob.handoff.controls, exact: true }).click();
        await A.page
            .getByRole("button", { name: language.serverJob.handoff.handOffTo.replace("{name}", B.tab), exact: true })
            .click();
        await role(B, f, "self");
    }
    async function held(c, kind) {
        return until(
            `${c.tab} held ${kind}`,
            () => calls(c),
            (rows) => rows.some((call) => call.kind === kind && call.phase === "held"),
        );
    }
    async function release(c, kind) {
        await (
            await sandbox(c)
        ).evaluate(
            (kind) =>
                globalThis.__jobHandoff.calls.find((call) => call.kind === kind && call.phase === "held").release(),
            kind,
        );
    }
    async function drainClosedHook(f, c, oldSandbox, name) {
        // A canceled delivered callback keeps its client's lane for another 60 s. After all
        // terminal assertions, acknowledge that navigation destroyed the old hook's sandbox,
        // so the next independent case can use this same client id without a drain hold.
        assert(oldSandbox.isDetached(), "The old plugin sandbox must be gone before reporting drained");
        const callback = callbacks(c, f).find((event) => event.name === name);
        assert(callback, `Missing delivered ${name} callback`);
        const response = await c.api(`/api/generations/${f.jobId}/drained?clientId=${c.id}`, {
            callbackId: callback.id,
        });
        assert.equal(response.status, 200, JSON.stringify(response));
        assert.equal(typeof response.body.drained, "boolean");
    }
    async function pending(f) {
        await role(B, f, "other", true);
        const label = language.serverJob.handoff.pending.replace("{character}", f.name);
        await B.page.getByRole("status").getByText(label, { exact: true }).waitFor();
        assert.deepEqual(await calls(B), []);
        assert.equal(callbacks(B, f).length, 0);
    }
    async function toast(c, text) {
        await until(
            `${c.tab} toast`,
            () => c.page.evaluate(() => window.__handoffToasts),
            (rows) => rows.includes(text),
        );
    }
    async function noSkippedToast(c) {
        const prefix = language.serverJob.hooksSkipped.split("{hooks}")[0];
        assert(!(await c.page.evaluate(() => window.__handoffToasts)).some((text) => text.includes(prefix)));
    }
    async function run(index, fn) {
        activeCase = names[index];
        caseStarted = Date.now();
        await fn();
        assert.deepEqual(
            clients.flatMap((c) => c.errors),
            [],
        );
        results.push(activeCase);
        console.log(`PASS ${activeCase} (${((Date.now() - caseStarted) / 1000).toFixed(2)}s)`);
    }

    await run(0, async () => {
        const f = await setup(0);
        await send(f);
        await close(A);
        await role(B, f, "self");
        assert.equal(callbacks(A, f).length, 0);
        await finish(f);
        await done(f);
        await reopen(A);
        await openCharacterChat(A.page, f.chaId);
        await noSkippedToast(A);
    });
    await run(1, async () => {
        const f = await setup(1);
        await send(f);
        await request(f);
        await role(B, f, "self");
        const viewing = await role(A, f, "other");
        assert.equal(viewing.clientName, B.tab);
        await toast(A, language.serverJob.handoff.takenBy.replace("{name}", B.tab));
        (await providerCall(f)).chunk("viewer update ");
        await until("creator receives stream as viewer", () =>
            events(A, f).some((e) => e.type === "chunk" && e.at >= viewing.at),
        );
        await A.page.locator(".chattext").filter({ hasText: "viewer update" }).first().waitFor();
        const before = await A.page.evaluate(async () => {
            let value;
            (await import("/src/ts/stores.svelte.ts")).ReloadGUIPointer.subscribe((next) => (value = next))();
            return value;
        });
        await finish(f);
        await done(f);
        assert(events(A, f).some((e) => e.type === "notice" && e.kind === "reloadDisplay"));
        await until(
            "creator applies display notice",
            () =>
                A.page.evaluate(async () => {
                    let value;
                    (await import("/src/ts/stores.svelte.ts")).ReloadGUIPointer.subscribe((next) => (value = next))();
                    return value;
                }),
            (value) => value > before,
        );
        assert.equal(callbacks(A, f).length, 0);
    });
    await run(2, async () => {
        const f = await setup(2, { A: { edit: true }, B: { edit: true } });
        await A.page.evaluate(async () => (await import("/src/ts/network/handoff.ts")).preferHandoff.set(true));
        await send(f);
        const switched = await role(B, f, "self");
        assert.equal(A.posts.at(-1).handoff, "prefer");
        await finish(f);
        await done(f);
        assert.equal(callbacks(A, f).filter((e) => e.at >= switched.at).length, 0);
        assert.deepEqual(
            callbacks(B, f).map((e) => e.name),
            ["editoutput", "chatOutput"],
        );
        assert((await calls(B)).every((call) => call.tab === "B" && call.phase === "done"));
    });
    await run(3, async () => {
        const f = await setup(3);
        await send(f);
        await manual(f);
        await finish(f);
        await done(f);
        assert(
            A.feed.some(
                (e) => e.type === "handoff" && e.jobId === f.jobId && e.reason === "requested" && e.target === B.id,
            ),
        );
    });
    await run(4, async () => {
        const f = await setup(4);
        // Playwright forces visibility on its own CDP session. A separate session cannot undo
        // that override; disable it on the in-process session before activating the cover tab.
        // This changes Chrome's focus emulation, never document.visibilityState or page timers.
        const focusSession = B.page._connection.toImpl(B.page).delegate._mainFrameSession._client;
        await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: false });
        const cover = await B.context.newPage();
        await cover.goto("about:blank");
        await cover.bringToFront();
        let method = "cover page in B's context; Playwright primary CDP focus override disabled";
        let cdp;
        let windowId;
        if ((await B.page.evaluate(() => document.visibilityState)) !== "hidden") {
            cdp = await B.context.newCDPSession(B.page);
            ({ windowId } = await cdp.send("Browser.getWindowForTarget"));
            await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
            method = "CDP Browser.setWindowBounds minimized";
        }
        await until(
            "worker really hidden",
            () => B.page.evaluate(() => document.visibilityState),
            (value) => value === "hidden",
        );
        const hiddenAt = Date.now();
        await send(f);
        await request(f);
        await role(B, f, "self");
        assert.equal(await B.page.evaluate(() => document.visibilityState), "hidden");
        await finish(f);
        await done(f);
        const finishedAt = Date.now();
        assert.equal(await B.page.evaluate(() => document.visibilityState), "hidden");
        const visibility = await B.page.evaluate(() => window.__handoffVisibility);
        assert(
            visibility.filter((e) => e.at >= hiddenAt && e.at <= finishedAt).every((e) => e.state === "hidden"),
            JSON.stringify(visibility),
        );
        const hook = callbacks(B, f).find((e) => e.name === "chatOutput");
        const answer = B.outgoing.find((e) => e.jobId === f.jobId && e.id === hook.id && e.type === "answer");
        assert(answer, "Hidden worker never answered the callback");
        console.log(
            `MEASURE hidden-worker: ${method}; visibility=hidden; socket-to-answer=${answer.at - hook.at}ms; job=${finishedAt - f.began}ms`,
        );
        if (cdp) {
            await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
            await cdp.detach();
        }
        await cover.close();
        await B.page.bringToFront();
        await focusSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    });
    await run(5, async () => {
        const f = await setup(5);
        await send(f);
        await manual(f);
        await providerCall(f);
        await close(B);
        await until("new absent offer", () =>
            A.feed.find(
                (e) => e.type === "handoff" && e.jobId === f.jobId && e.state === "open" && e.reason === "absent",
            ),
        );
        await until(
            "creator takes ownership back",
            () =>
                events(A, f)
                    .filter((e) => e.type === "handoff")
                    .at(-1)?.owner === "self",
        );
        await finish(f);
        await done(f, "A");
        assert.equal(callbacks(B, f).length, 0);
        await reopen(B);
    });
    await run(6, async () => {
        const f = await setup(6, { A: { edit: true, hold: "editoutput" }, B: { edit: true } });
        await send(f);
        await finish(f);
        await held(A, "editoutput");
        await request(f, B.id);
        await pending(f);
        await release(A, "editoutput");
        await role(B, f, "self");
        await done(f);
        const text = await marked(f, "B");
        assert(text.includes("[editoutput:A]"), text);
        assert.deepEqual(
            callbacks(A, f).map((e) => e.name),
            ["editoutput"],
        );
        assert.deepEqual(
            callbacks(B, f).map((e) => e.name),
            ["chatOutput"],
        );
    });
    await run(7, async () => {
        const f = await setup(7, { A: { body: true, hold: "bodyIntercepter" }, B: { body: true } });
        await send(f);
        await held(A, "bodyIntercepter");
        const oldSandbox = await sandbox(A);
        await close(A);
        await pending(f);
        const result = await ended(f);
        assert.equal(result.terminal.type, "error", JSON.stringify(result));
        assert.equal(result.terminal.reason, "failed", JSON.stringify(result));
        assert.match(result.terminal.message, /bodyIntercepter callback disconnected/);
        assert.deepEqual(await calls(B), []);
        assert.equal(callbacks(B, f).length, 0);
        assert.equal(providerCalls.length, f.providerIndex);
        await reopen(A);
        await until(
            "creator sees the job error",
            () =>
                A.page.evaluate(async () => {
                    let value;
                    (await import("/src/ts/stores.svelte.ts")).alertStore.subscribe((next) => (value = next))();
                    return value;
                }),
            (value) =>
                value?.type === "error" &&
                value.jobFailure?.jobId === f.jobId &&
                /bodyIntercepter callback disconnected/.test(value.jobFailure.end.message),
        );
        await drainClosedHook(f, A, oldSandbox, "bodyIntercepter");
    });
    await run(8, async () => {
        const f = await setup(8, { A: { hold: "chatOutput" } });
        await send(f);
        await finish(f);
        await held(A, "chatOutput");
        // The latch precedes the metadata write, so closing cannot race an unsaved marker.
        await marked(f, null, 0);
        const oldSandbox = await sandbox(A);
        await close(A);
        await pending(f);
        const result = await ended(f);
        assert.equal(result.terminal.type, "done", JSON.stringify(result));
        assert.deepEqual(result.terminal.skipped ?? [], []);
        assert.deepEqual(
            result.terminal.missed?.map((e) => e.name),
            ["chatOutput"],
        );
        await marked(f, null, 0);
        assert.deepEqual(await calls(B), []);
        assert.equal(callbacks(B, f).length, 0);
        await reopen(A);
        await toast(A, language.serverJob.handoff.missedCallback);
        await marked(f, null, 0);
        assert.deepEqual(await calls(A), []);
        await drainClosedHook(f, A, oldSandbox, "chatOutput");
    });
    await run(9, async () => {
        const f = await setup(9);
        await send(f);
        await manual(f);
        await close(B);
        await close(A);
        await finish(f);
        const result = await ended(f);
        assert.equal(result.terminal.type, "done", JSON.stringify(result));
        assert.deepEqual(
            result.terminal.skipped?.map((e) => e.name),
            ["chatOutput"],
        );
        assert.deepEqual(result.terminal.missed ?? [], []);
        await marked(f, null, 0);
        assert.equal(callbacks(A, f).length + callbacks(B, f).length, 0);
        await reopen(A);
        await until(
            "late marker persisted",
            () => readChat(f),
            (chat) => markers(chat).some((entry) => entry.tab === "A"),
        );
        await marked(f, "A");
        assert.equal((await calls(A)).filter((call) => call.kind === "chatOutput").length, 1);
        // A second resume of the same saved-job lifecycle must not replay the listener twice.
        await A.page.evaluate(async () => (await import("/src/ts/process/serverCommands.ts")).resumeServerJobs());
        await marked(f, "A");
        assert.equal((await calls(A)).filter((call) => call.kind === "chatOutput").length, 1);
    });
} catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${activeCase} (${((Date.now() - caseStarted) / 1000).toFixed(2)}s): ${error.stack}`);
    console.error("Fixture:", JSON.stringify(activeFixture));
    for (const c of clients) {
        console.error(
            c.tab,
            JSON.stringify({
                events: c.events.filter((e) => !activeFixture?.jobId || e.jobId === activeFixture.jobId).slice(-16),
                outgoing: c.outgoing.slice(-8),
                feed: c.feed.filter((e) => e.type === "handoff").slice(-8),
                errors: c.errors,
            }),
        );
        console.error(
            "Page:",
            (
                await c.page
                    .locator("body")
                    .innerText()
                    .catch(() => "")
            ).slice(-2200),
        );
        for (const frame of c.page.frames()) {
            const state = await frame
                .evaluate(
                    () =>
                        globalThis.__jobHandoff &&
                        JSON.stringify(globalThis.__jobHandoff, (key, value) =>
                            typeof value === "function" ? undefined : value,
                        ),
                )
                .catch(() => null);
            if (state) console.error("Plugin:", state);
        }
    }
    console.error("Server tail:", serverLog.join("").slice(-5000));
    for (const name of names)
        if (!results.includes(name) && name !== activeCase)
            console.log(`FAIL ${name} (not run after ${activeCase} failure)`);
} finally {
    try {
        if (stack) {
            const denied = await stack.deniedEgress();
            assert.deepEqual(unexpectedEgress(blocked.flat(), denied), []);
            console.log(`PASS egress (${denied.length} expected server attempts denied)`);
        }
    } catch (error) {
        process.exitCode = 1;
        console.error(`FAIL egress: ${error.message}`);
    } finally {
        await browser?.close();
        await stack?.stop();
        for (const call of providerCalls) call.finish?.();
        provider.closeAllConnections();
        await new Promise((resolve) => provider.close(resolve));
    }
    console.log(
        `${results.length}/${names.length} cases passed (${((Date.now() - started) / 1000).toFixed(2)}s total)`,
    );
}
