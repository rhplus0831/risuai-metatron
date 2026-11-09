// Browser checks of generation receipts, server command sequences, foreign Stop, owner absence,
// and crash checkpoints, with a real installed v3 plugin provider in system Chrome.
// Report unexpected document reloads as harness noise; retry a failed case once after a Vite
// dependency-optimization reload, retaining the discarded error and client errors as diagnostics.
// Usage: node util/playwright/checkJobProtocol.mjs
// Prefer: util/playwright/offline.sh node util/playwright/checkJobProtocol.mjs
// Optional: SERVER_PORT=6281 VITE_PORT=5381 DEBUG=1 (ports must be free).
//
// The production owner-absence allowance applies until the final owner-closed-mid-provider case.
// While idle before that case, rewrite the temporary --import preload and gracefully restart to
// replace only OWNER_ABSENT_MS with 4000 (an exact match), without a product setting.
// NODE_OPTIONS replaces stack.mjs's preload, so this preload also installs its equivalent
// fetch guard, writing the same denied-egress.log consumed by deniedEgress/unexpectedEgress.
// offline.sh supplies the transport-independent boundary, including Lua and browser sockets.
// All resources and receipts live in the stack's temporary save/, retained across SIGKILL.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
import {
    chromePath,
    isolateContext,
    openApp as stackOpenApp,
    openCharacterChat,
    pluginFixtureOp,
    repoRoot,
    startStack,
    unexpectedEgress,
} from "./stack.mjs";

const ABSENT_MS = 4000;
const constants = async (file, name) => {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    const match = source.match(new RegExp(`export const ${name} = ([\\d_]+);`));
    assert(match, `Cannot read ${name} from ${file}`);
    return Number(match[1].replaceAll("_", ""));
};
const ABORT_GRACE_MS = await constants("server/src/jobs/generationJobs.ts", "JOB_ABORT_GRACE_MS");
const CHECKPOINT_MS = await constants("server/src/prompt/runner.ts", "CHECKPOINT_INTERVAL_MS");
const names = [
    "lost-create-answer",
    "reload-mid-sequence",
    "stop-from-other-context",
    "sigkill-before-checkpoint",
    "owner-closed-mid-provider",
];

// No network or host DOM API is needed. Playwright evaluates flags in the actual sandbox frame;
// the provider callback itself still crosses both the sandbox RPC and the server job channel.
// Every invocation starts held, and an abort drains it so another send can use the client's lane.
const pluginName = "BrowserJobProvider";
const pluginScript = `//@name ${pluginName}
//@api 3.0
const state = globalThis.__jobProtocol = { ready: false, calls: [] };
await risuai.addProvider("${pluginName}", async (args, signal) => {
    let resolve;
    const promise = new Promise(done => resolve = done);
    const call = { prompt: args.prompt_chat, phase: "held", resolve, controller: null };
    state.calls.push(call);
    signal?.addEventListener("abort", () => {
        if (call.phase === "held") resolve({ success: false, content: "aborted" });
        if (call.phase === "streaming") { try { call.controller.close(); } catch {} }
        call.phase = "aborted";
    }, { once: true });
    return await promise;
}, { tokenizer: "tik" });
state.ready = true;
`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label, read, predicate = Boolean, timeout = 30_000, interval = 50) {
    let last;
    for (const end = Date.now() + timeout; Date.now() < end;) {
        last = await read();
        if (predicate(last)) return last;
        await delay(interval);
    }
    throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
}
async function requireFreePort(port) {
    const listener = createServer();
    await new Promise((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, resolve);
    });
    await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}

const temporary = await mkdtemp(path.join(os.tmpdir(), "risu-job-protocol-"));
let stack;
let browser;
const blocked = [];
const serverLog = [];
const clients = [];
const results = [];
let activeCase = "setup";
const started = Date.now();
let caseStarted = started;
try {
    const serverPort = Number(process.env.SERVER_PORT ?? 6281);
    const vitePort = Number(process.env.VITE_PORT ?? 5381);
    await Promise.all([requireFreePort(serverPort), requireFreePort(vitePort)]);
    const hook = `export async function load(url, context, nextLoad) {
        const result = await nextLoad(url, context);
        if (url === ${JSON.stringify(pathToFileURL(path.join(repoRoot, "server/src/jobs/generationJobs.ts")).href)}) {
            const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
            const original = "export const OWNER_ABSENT_MS = 120_000;";
            if (source.split(original).length !== 2) throw new Error("Owner absence loader: expected exactly one constant");
            return { ...result, source: source.replace(original, "export const OWNER_ABSENT_MS = ${ABSENT_MS};") };
        }
        return result;
    }`;
    const preload = path.join(temporary, "preload.mjs");
    const writePreload = (shortAbsence = false) =>
        writeFile(
            preload,
            `import { register } from "node:module";
import { appendFileSync } from "node:fs";
import path from "node:path";
${shortAbsence ? `register(${JSON.stringify("data:text/javascript," + encodeURIComponent(hook))}, import.meta.url);` : ""}
const local = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "host.docker.internal"]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    if (url.protocol === "data:" || url.protocol === "blob:" || local.has(url.hostname)) return realFetch(input, init);
    appendFileSync(path.join(process.cwd(), "denied-egress.log"), url.href + "\\n");
    throw new TypeError("egress denied by the check harness: " + url.origin);
};
`,
        );
    await writePreload();
    stack = await startStack({
        serverPort,
        vitePort,
        serverEnv: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` },
        log: (line) => {
            serverLog.push(line);
            if (process.env.DEBUG) process.stderr.write(line);
        },
    });
    browser = await chromium.launch({ executablePath: chromePath, headless: true });

    let caseAttempt = null;
    async function openApp(page, baseURL) {
        const c = clients.find((entry) => entry.page === page);
        c.openingApp = true;
        try {
            await stackOpenApp(page, baseURL);
            // Boot may itself ride out a Vite reload. Only navigations after the most recent
            // completed driver open count, including for an open in the middle of a case.
            if (caseAttempt) caseAttempt.navigations = caseAttempt.navigations.filter((nav) => nav.client !== c);
        } finally {
            c.openingApp = false;
        }
    }

    async function client() {
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        blocked.push(await isolateContext(context));
        // Like clearSafeBootAttempts, but only the top-level document has localStorage:
        // an init script also runs in the plugin's opaque-origin sandbox.
        await context.addInitScript(() => {
            if (window === window.top) localStorage.removeItem("risu.safeBoot.attempts");
        });
        const page = await context.newPage();
        const c = {
            context,
            page,
            label: `client-${clients.length + 1}`,
            openingApp: false,
            auth: null,
            epoch: null,
            posts: [],
            events: [],
            outgoing: [],
            errors: [],
        };
        clients.push(c);
        const navigation = await context.newCDPSession(page);
        // CDP reports document commits here; pushState/anchor changes instead emit
        // Page.navigatedWithinDocument, so SPA routing cannot be mistaken for a reload.
        navigation.on("Page.frameNavigated", ({ frame }) => {
            if (frame.parentId || !caseAttempt || c.openingApp) return;
            caseAttempt.navigations.push({
                client: c,
                page: c === owner ? `owner (${c.label})` : c.label,
                elapsed: Date.now() - caseAttempt.began,
                url: frame.url,
            });
        });
        await navigation.send("Page.enable");
        page.on("pageerror", (error) => c.errors.push(String(error)));
        page.on("request", (req) => {
            const headers = req.headers();
            if (headers["risu-auth"]) c.auth = headers["risu-auth"];
            if (headers["x-resource-epoch"]) c.epoch = headers["x-resource-epoch"];
            if (req.method() === "POST" && new URL(req.url()).pathname === "/api/generations") {
                c.posts.push(req.postDataJSON());
            }
        });
        page.on("response", (res) => {
            if (res.headers()["x-resource-epoch"]) c.epoch = res.headers()["x-resource-epoch"];
        });
        page.on("websocket", (socket) => {
            if (!socket.url().includes("/api/generations/")) return;
            const jobId = new URL(socket.url()).pathname.split("/").at(-2);
            for (const [event, target] of [
                ["framereceived", c.events],
                ["framesent", c.outgoing],
            ]) {
                socket.on(event, ({ payload }) => {
                    try {
                        target.push({ at: Date.now(), jobId, ...JSON.parse(String(payload)) });
                    } catch {}
                });
            }
        });
        c.api = async (url, body, method = body === undefined ? "GET" : "POST") => {
            const response = await fetch(stack.baseURL + url, {
                method,
                headers: {
                    "risu-auth": c.auth,
                    "x-resource-epoch": c.epoch,
                    "content-type": "application/json",
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const bodyResult = await response.json().catch(() => null);
            if (bodyResult?.epoch) c.epoch = bodyResult.epoch;
            return { status: response.status, body: bodyResult };
        };
        await openApp(page, stack.baseURL);
        await until("authenticated browser request", () => c.auth);
        return c;
    }
    let owner = await client();
    // Boot queues creation of the empty plugin list. Settle that write before taking revisions
    // for the seed, whether the save debounce ran before openApp returned or after it.
    const bootWrites = await owner.page.evaluate(async () => {
        const { flushResources } = await import("/src/ts/storage/resourceSync.svelte.ts");
        return flushResources();
    });
    assert.deepEqual(bootWrites, { discarded: [], refused: [] });
    async function single(kind) {
        const response = await owner.api(`/api/resources/${kind}/main`);
        if (kind === "plugins" && response.status === 404) return { revision: null, data: [] };
        assert.equal(response.status, 200, JSON.stringify(response));
        return response.body;
    }
    const records = Object.fromEntries(
        await Promise.all(
            ["ui", "presets", "modelPresets", "modelProfiles", "personas", "providers", "plugins"].map(async (kind) => [
                kind,
                await single(kind),
            ]),
        ),
    );
    const preset = { ...records.presets.data[0], mainPrompt: "Reply briefly.", maxResponse: 100 };
    const seeded = await owner.api("/api/resources/batch", {
        ops: [
            ...modelFixtureOps(
                { aiModel: `pluginmodel:::${pluginName}`, maxContext: 4000, customTokenizer: "tik" },
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
        ],
    });
    assert.equal(seeded.status, 200, JSON.stringify(seeded));
    await openApp(owner.page, stack.baseURL);
    const language = await owner.page.evaluate(async () => {
        const { language } = await import("/src/lang/index.ts");
        return JSON.parse(JSON.stringify(language));
    });
    async function sandbox(c) {
        return until("registered plugin sandbox", async () => {
            for (const frame of c.page.frames()) {
                if (await frame.evaluate(() => globalThis.__jobProtocol?.ready).catch(() => false)) return frame;
            }
            return null;
        });
    }
    async function calls(c) {
        const frame = await sandbox(c);
        return frame.evaluate(() => globalThis.__jobProtocol.calls.map(({ prompt, phase }) => ({ prompt, phase })));
    }
    async function control(c, index, action, text) {
        const frame = await sandbox(c);
        await frame.evaluate(
            ({ index, action, text }) => {
                const call = globalThis.__jobProtocol.calls[index];
                if (!call) throw new Error(`No provider call ${index}`);
                if (action === "reply") {
                    call.phase = "answered";
                    call.resolve({ success: true, content: text });
                } else if (action === "stream") {
                    call.phase = "streaming";
                    call.resolve({
                        success: true,
                        content: new ReadableStream({
                            start(controller) {
                                call.controller = controller;
                            },
                        }),
                    });
                } else if (action === "chunk") {
                    call.controller.enqueue(text);
                } else throw new Error(`Unknown action ${action}`);
            },
            { index, action, text },
        );
    }
    async function waiting(c, index = 0) {
        await until(
            "provider callback dispatched and unanswered",
            async () => {
                const consent = c.page.getByText(language.providerPermissionConsent.replace("{}", pluginName), {
                    exact: true,
                });
                if (await consent.isVisible().catch(() => false)) {
                    await c.page.getByRole("button", { name: "YES", exact: true }).click();
                }
                return calls(c);
            },
            (rows) => rows[index]?.phase === "held",
        );
        assert(
            c.events.some((event) => event.type === "callback" && event.name === "provider"),
            "No provider channel event",
        );
    }
    async function fixture(name, extra = {}) {
        const chaId = randomUUID();
        const chatId = randomUUID();
        const order = await single("characterOrder");
        const character = {
            name,
            firstMessage: "Hello from the browser fixture.",
            desc: "",
            notes: "",
            chatFolders: [],
            emotionImages: [],
            bias: [],
            viewScreen: "none",
            globalLore: [],
            chaId,
            type: "character",
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
            ...extra,
        };
        const response = await owner.api("/api/resources/batch", {
            ops: [
                { kind: "characters", id: chaId, baseRevision: null, data: character },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...order.data, chaId],
                },
            ],
            chats: [
                {
                    characterId: chaId,
                    chatId,
                    baseRevision: null,
                    ops: [
                        {
                            op: "create",
                            chat: {
                                id: chatId,
                                name: "Protocol chat",
                                fmIndex: -1,
                                message: [],
                                ...chatBindingFixture(records.modelPresets, records.presets, records.personas),
                            },
                        },
                    ],
                },
            ],
        });
        assert.equal(response.status, 200, JSON.stringify(response));
        await openApp(owner.page, stack.baseURL);
        await sandbox(owner);
        await openCharacterChat(owner.page, chaId);
        await owner.page.locator("textarea.input-text").waitFor();
        const current = (c = owner) =>
            c.api(`/api/generations/current?${new URLSearchParams({ characterId: chaId, chatId })}`);
        const messages = async () => {
            const response = await owner.api("/api/resources/read", { chatCollections: [chaId] });
            assert.equal(response.status, 200, JSON.stringify(response));
            const chat = response.body.chatCollections[0].chats.find((entry) => entry.id === chatId);
            assert(chat, "Chat missing from server read");
            return chat.data.message;
        };
        return { chaId, chatId, current, messages };
    }
    const input = (c = owner) => c.page.locator("textarea.input-text").first();
    async function send(text, c = owner) {
        await input(c).fill(text);
        await input(c).press("Enter");
    }
    async function idle(f) {
        await until("chat slot released", f.current, (response) => response.status === 404);
        await until(
            "owner send settled",
            () => owner.page.locator('button[aria-labelledby="cancel"]').count(),
            (n) => n === 0,
        );
    }
    async function visible(text, c = owner) {
        await c.page.getByText(text, { exact: true }).first().waitFor({ timeout: 30_000 });
    }
    async function run(name, fn) {
        activeCase = name;
        for (let attempt = 0; attempt < 2; attempt++) {
            const began = Date.now();
            caseStarted = began;
            caseAttempt = { began, logStart: serverLog.length, navigations: [] };
            const errorStarts = new Map(clients.map((c) => [c, c.errors.length]));
            try {
                // The owner-close case may throw before its final owner reassignment.
                if (attempt > 0 && owner.page.isClosed()) owner = await client();
                await fn();
                assert(
                    clients.every((c) => c.errors.length === 0),
                    JSON.stringify(clients.flatMap((c) => c.errors)),
                );
                const elapsed = ((Date.now() - began) / 1000).toFixed(2);
                results.push(name);
                console.log(`PASS ${name} (${elapsed}s)`);
                return;
            } catch (error) {
                // The stack callback receives chunks from both server and Vite; join them so a
                // reload line split between chunks is still recognized for this attempt only.
                const viteReload = serverLog
                    .slice(caseAttempt.logStart)
                    .join("")
                    .includes("optimized dependencies changed. reloading");
                for (const nav of caseAttempt.navigations) {
                    console.error(
                        `HARNESS ${name}: unexpected main-frame reload caused this attempt to fail: ${nav.page} at +${(nav.elapsed / 1000).toFixed(2)}s (${nav.url}); Vite reload line seen: ${viteReload ? "yes" : "no"}`,
                    );
                }
                if (attempt > 0 || !viteReload) throw error;
                console.error(
                    `DISCARDED ${name} attempt 1 (${((Date.now() - began) / 1000).toFixed(2)}s): ${error.stack ?? error}`,
                );
                const discardedErrors = clients.flatMap((c) => {
                    const errors = c.errors.splice(errorStarts.get(c) ?? 0);
                    return errors.length ? [{ page: c.label, errors }] : [];
                });
                console.error(`DISCARDED ${name} client errors: ${JSON.stringify(discardedErrors)}`);
                console.log(
                    `RERUN ${name}: Vite logged "optimized dependencies changed. reloading" during the failed attempt; retrying once with a fresh fixture.`,
                );
            } finally {
                caseAttempt = null;
            }
        }
    }

    await run(names[0], async () => {
        const f = await fixture(names[0]);
        const posts = [];
        let firstAnswer;
        let replay;
        let routeFailure;
        await owner.page.route("**/api/generations", async (route) => {
            if (route.request().method() !== "POST") return route.continue();
            try {
                posts.push(route.request().postDataJSON());
                const response = await route.fetch();
                const answer = await response.json();
                if (posts.length === 1) {
                    assert.equal(response.status(), 200);
                    firstAnswer = answer;
                    // The server has admitted the job; only its answer to this tab is lost.
                    await route.abort("connectionfailed");
                } else {
                    replay = answer;
                    await route.fulfill({ response });
                }
            } catch (error) {
                routeFailure = error;
                await route.abort().catch(() => {});
            }
        });
        try {
            await send("Recover the lost create answer.");
            await until("same-id automatic retry replay", () => {
                if (routeFailure) throw routeFailure;
                return replay;
            });
            assert.equal(posts.length, 2);
            assert(posts[0].requestId);
            assert.deepEqual(posts[1], posts[0]);
            assert.equal(replay.replayed, true);
            assert.equal(replay.jobId, firstAnswer.jobId);
            await waiting(owner);
            await control(owner, 0, "reply", "One recovered reply.");
            await idle(f);
            assert.deepEqual(
                (await f.messages()).map((m) => [m.role, m.data]),
                [
                    ["user", "Recover the lost create answer."],
                    ["char", "One recovered reply."],
                ],
            );
            assert.equal((await calls(owner)).length, 1);
            assert.equal(await input().inputValue(), "");
        } finally {
            await owner.page.unroute("**/api/generations");
        }
    });

    await run(names[1], async () => {
        // Lua has no slash-command host function: its manual handler supplies the command to a
        // native v2Command effect, in the same server command job. The typed composer /multisend
        // is page-owned and would exercise a different path.
        // A native onStart sleep for part two gives a callback-free reload window: part one's
        // provider is answered, its reply is stored, and the server is between provider calls.
        // Wait for the Lua notice that precedes the sleeps, then reload. Assert no outstanding
        // callback at navigation and no later callback was delivered to the old page. If boot
        // misses this 6 s window the check fails; it never treats an unknown callback replay as
        // a successful reload between parts. The provider remains explicitly held for each part.
        const sep = "{{u::7c}}".repeat(3);
        const command = `/multisend Sequence user one.${sep}Sequence user two.${sep}Sequence user three.`;
        const f = await fixture(names[1], {
            firstMessage: '<button risu-trigger="sequence">Run sequence</button>',
            triggerscript: [
                {
                    comment: "sequence",
                    type: "manual",
                    conditions: [],
                    effect: [
                        { type: "v2Header", indent: 0 },
                        {
                            type: "triggerlua",
                            code: `sequence = function(id) setChatVar(id, "command", ${JSON.stringify(command)}) end`,
                        },
                        { type: "v2Command", indent: 0, value: "{{getvar::command}}", valueType: "value" },
                    ],
                },
                {
                    comment: "callback-free pause",
                    type: "manual",
                    conditions: [],
                    effect: [
                        {
                            type: "triggerlua",
                            code: `onStart = async(function(id)
                        if getUserLastMessage(id) == "Sequence user two." then
                            alertNormal(id, "Browser sequence callback-free pause")
                            for i = 1, 3 do sleep(id, 2000):await() end
                        end
                    end)`,
                        },
                    ],
                },
            ],
        });
        const eventStart = owner.events.length;
        const postStart = owner.posts.length;
        const clientId = await owner.page.evaluate(async () =>
            (await import("/src/ts/network/generationJobs.ts")).generationClientId(),
        );
        await owner.page.locator('[risu-trigger="sequence"]').first().click();
        await waiting(owner);
        await control(owner, 0, "reply", "Sequence reply one.");
        await until("native callback-free sequence pause", () =>
            owner.events
                .slice(eventStart)
                .find((e) => e.type === "notice" && e.payload?.message === "Browser sequence callback-free pause"),
        );
        assert.deepEqual(
            (await f.messages()).map((m) => m.data),
            ["Sequence user one.", "Sequence reply one.", "Sequence user two."],
        );
        const outstanding = owner.events
            .slice(eventStart)
            .filter(
                (e) =>
                    e.type === "callback" &&
                    !owner.outgoing.some((answer) => answer.id === e.id && answer.type === "answer"),
            );
        assert.equal(outstanding.length, 0, JSON.stringify(outstanding));
        const navigatingAt = Date.now();
        await openApp(owner.page, stack.baseURL);
        await sandbox(owner);
        await openCharacterChat(owner.page, f.chaId);
        assert.equal(
            await owner.page.evaluate(async () =>
                (await import("/src/ts/network/generationJobs.ts")).generationClientId(),
            ),
            clientId,
        );
        await visible("Sequence user one.");
        await visible("Sequence reply one.");
        await waiting(owner);
        const later = owner.events.slice(eventStart).filter((e) => e.type === "callback" && e.at >= navigatingAt);
        assert(
            later.every((e) => !e.replay),
            JSON.stringify(later),
        );
        await control(owner, 0, "reply", "Sequence reply two.");
        await waiting(owner, 1);
        await control(owner, 1, "reply", "Sequence reply three.");
        await idle(f);
        const expected = [
            "Sequence user one.",
            "Sequence reply one.",
            "Sequence user two.",
            "Sequence reply two.",
            "Sequence user three.",
            "Sequence reply three.",
        ];
        assert.deepEqual(
            (await f.messages()).map((m) => m.data),
            expected,
        );
        for (const text of expected) await visible(text);
        assert.equal(owner.posts.length - postStart, 1);
        assert.equal(owner.posts.at(-1).kind, "command");
        const terminal = owner.events.slice(eventStart).find((e) => e.type === "done");
        assert.deepEqual(terminal?.sequence, { total: 3, sent: 3 });
    });

    await run(names[2], async () => {
        const f = await fixture(names[2]);
        await send("Hold while the other context stops this job.");
        await waiting(owner);
        // A visible partial reply establishes the server lock that advertises busy state
        // to the foreign context. The real plugin stream then stays unanswered until Stop.
        await control(owner, 0, "stream");
        await control(owner, 0, "chunk", "Held for the other context to stop.");
        await visible("Held for the other context to stop.");
        const foreign = await client();
        try {
            await openCharacterChat(foreign.page, f.chaId);
            const ids = await Promise.all(
                [owner, foreign].map((c) =>
                    c.page.evaluate(async () =>
                        (await import("/src/ts/network/generationJobs.ts")).generationClientId(),
                    ),
                ),
            );
            assert.notEqual(ids[0], ids[1]);
            const lookup = await foreign.api(
                `/api/generations/current?${new URLSearchParams({ characterId: f.chaId, chatId: f.chatId, clientId: ids[1] })}`,
            );
            assert.equal(lookup.status, 200);
            assert.equal(lookup.body.owned, false);
            assert(lookup.body.stage);
            const [uiResponse] = await Promise.all([
                foreign.page.waitForResponse((res) => new URL(res.url()).pathname === "/api/generations/current"),
                foreign.page.getByRole("button", { name: language.serverJob.stopOther.label, exact: true }).click(),
            ]);
            const uiLookup = await uiResponse.json();
            const text = language.serverJob.stopOther;
            const expected = text.confirm
                .replace("{kind}", text.kinds[uiLookup.kind])
                .replace("{stage}", text.stages[uiLookup.stage] ?? text.running)
                .replace("{sequence}", "");
            await visible(expected, foreign);
            // AlertComp's YES/NO controls are literal in the application.
            const [response] = await Promise.all([
                foreign.page.waitForResponse((res) => new URL(res.url()).pathname === "/api/generations/stop"),
                foreign.page.getByRole("button", { name: "YES", exact: true }).click(),
            ]);
            assert.equal(response.status(), 200);
            assert.equal(response.request().postDataJSON().jobId, uiLookup.jobId);
            await visible(language.serverJob.stoppedElsewhere);
            await idle(f);
            assert(owner.events.some((e) => e.type === "error" && e.abortedBy === "other"));
            await send("The chat is free for a new send.");
            await waiting(owner, 1);
            await control(owner, 1, "reply", "Admitted after foreign stop.");
            await idle(f);
            assert.equal((await f.messages()).at(-1).data, "Admitted after foreign stop.");
        } finally {
            await foreign.context.close();
        }
    });

    await run(names[3], async () => {
        const f = await fixture(names[3]);
        const eventStart = owner.events.length;
        await send("Checkpoint the first chunk, then crash.");
        await waiting(owner);
        await control(owner, 0, "stream");
        await control(owner, 0, "chunk", "Checkpointed chunk A.");
        await visible("Checkpointed chunk A.");
        const checkpointSeenAt = await until(
            "chunk A persisted by the checkpoint timer",
            async () => {
                const messages = await f.messages();
                return messages.at(-1)?.data === "Checkpointed chunk A." ? Date.now() : null;
            },
            Boolean,
            CHECKPOINT_MS * 3,
        );
        const current = await f.current();
        const clientId = owner.posts.at(-1).clientId;
        await control(owner, 0, "chunk", " Visible-only chunk B.");
        await visible("Checkpointed chunk A. Visible-only chunk B.");
        const killedAt = Date.now();
        assert(killedAt - checkpointSeenAt < CHECKPOINT_MS / 2, "Missed the interval before the next checkpoint");
        // Invoking restartServer kills immediately, before its asynchronous restart/readiness wait.
        await stack.restartServer({ signal: "SIGKILL" });
        const status = await owner.api(`/api/generations/${current.body.jobId}?clientId=${clientId}`);
        assert.equal(status.status, 200);
        assert.equal(status.body.kept, true);
        assert.equal(status.body.terminal.type, "error");
        assert.equal(status.body.terminal.reason, "shutdown");
        await visible(status.body.terminal.message);
        const alert = await owner.page.evaluate(async () => {
            const { alertStore } = await import("/src/ts/stores.svelte.ts");
            let value;
            alertStore.subscribe((current) => {
                value = {
                    type: current.type,
                    jobId: current.jobFailure?.jobId,
                    reason: current.jobFailure?.end.reason,
                };
            })();
            return value;
        });
        assert.deepEqual(alert, { type: "error", jobId: current.body.jobId, reason: "shutdown" });
        assert.equal((await f.messages()).at(-1).data, "Checkpointed chunk A.");
        await until(
            "page reconciles the checkpointed reply",
            () => owner.page.locator(".chattext").allTextContents(),
            (texts) =>
                texts.some((text) => text.includes("Checkpointed chunk A.")) &&
                texts.every((text) => !text.includes("Visible-only chunk B.")),
        );
        assert(!owner.events.slice(eventStart).some((e) => e.type === "done"), "Crash incorrectly completed the job");
    });

    await run(names[4], async () => {
        await writePreload(true);
        await stack.restartServer();
        const f = await fixture(names[4]);
        await send("The owner will close during this provider callback.");
        await waiting(owner);
        const current = await f.current();
        assert.equal(current.status, 200);
        const closedAt = Date.now();
        await owner.page.close();
        await delay(Math.min(500, ABSENT_MS / 4));
        assert.equal((await f.current()).status, 200, "Chat freed before the absence wait");
        const bound = ABSENT_MS + ABORT_GRACE_MS;
        await until(
            "closed owner's chat frees within absence plus abort grace",
            f.current,
            (response) => response.status === 404,
            Math.max(1, closedAt + bound - Date.now()),
        );
        assert(Date.now() - closedAt < bound, `Release exceeded ${bound} ms`);
        const job = await owner.api(`/api/generations/${current.body.jobId}?clientId=${owner.posts.at(-1).clientId}`);
        assert.equal(job.status, 200);
        assert.equal(job.body.terminal.type, "error");
        assert.notEqual(job.body.terminal.reason, "aborted");
        owner = await client();
    });
} catch (error) {
    process.exitCode = 1;
    console.error(`FAIL ${activeCase} (${((Date.now() - caseStarted) / 1000).toFixed(2)}s): ${error.stack}`);
    const c = clients.at(-1);
    if (c && !c.page.isClosed())
        console.error(
            "Page:",
            (
                await c.page
                    .locator("body")
                    .innerText()
                    .catch(() => "")
            ).slice(-3500),
        );
    if (c)
        console.error(
            "Channel:",
            JSON.stringify({ events: c.events.slice(-12), outgoing: c.outgoing.slice(-8), errors: c.errors }),
        );
    console.error("Server tail:", serverLog.join("").slice(-4000));
    for (const name of names) {
        if (!results.includes(name) && name !== activeCase)
            console.log(`FAIL ${name} (not run after ${activeCase} failure)`);
    }
} finally {
    try {
        if (stack) {
            const denied = await stack.deniedEgress();
            const unexpected = unexpectedEgress(blocked.flat(), denied);
            assert.equal(unexpected.length, 0, JSON.stringify(unexpected));
            console.log(`PASS egress (${denied.length} expected server attempts denied)`);
        }
    } catch (error) {
        console.error(`FAIL egress: ${error.message}`);
        process.exitCode = 1;
    } finally {
        await browser?.close();
        await stack?.stop();
        await rm(temporary, { recursive: true, force: true });
    }
    console.log(
        `${results.length}/${names.length} cases passed (${((Date.now() - started) / 1000).toFixed(2)}s total)`,
    );
}
