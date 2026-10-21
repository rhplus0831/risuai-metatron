import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";
// The Phase 6 Stop D Docker smoke (the closeout's two-client matrix), against the built app (the
// Docker image on a fresh volume), through the UI and the public API only (no dev modules):
// - first run: client A sets the password of the fresh server, client B (another browser context,
//   its own key pair) logs in with it;
// - two clients converge: a character edit typed in A shows in B and one typed in B shows in A, and a
//   third writer's chat append through the routes shows in both, with no reload notice and no write
//   back; each convergence delay is recorded;
// - a send runs as a server job against a mock provider, with a sentinel credential set through the
//   public `llmSecrets` route (never by the browser): the provider receives the sentinel, both
//   clients show the reply and it is stored, and the sentinel appears nowhere in either browser's
//   traffic (request and response headers and bodies, and every WebSocket frame both ways);
// - restart (`--restart-cmd`, e.g. `docker restart <container>`): the state before it is stored after
//   it, a route write made once the server is healthy (before the clients have reconnected) reaches
//   both clients at their reconnect without a reload, and A's next edit saves;
// - archive import: an archive exported in state S1, a change (S2), the import (a safety snapshot of
//   S2 first): both clients are told, reload after OK, and show S1; an edit saves afterwards;
// - snapshot restore: the import's safety snapshot (the one id the import added to the list) restored
//   by id: both clients are told, reload, and show S2; an edit saves afterwards;
// - no page error and no unexpected outbound request.
//
// Usage:
//   node util/playwright/checkTwoClientSmoke.mjs --base http://localhost:6270 --password docker-pw \
//       --provider-host host.docker.internal --restart-cmd "docker restart risu-stopd"
// The mock provider listens on every interface; the server reaches it as `--provider-host`.
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, unexpectedEgress } from "./stack.mjs";

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const base = option("--base");
const password = option("--password") ?? "docker-pw";
const providerHost = option("--provider-host") ?? "127.0.0.1";
const restartCmd = option("--restart-cmd");
if (!base || !restartCmd) {
    console.error(
        "Usage: node util/playwright/checkTwoClientSmoke.mjs --base <url> --restart-cmd <cmd> [--password <pw>] [--provider-host <host>]",
    );
    process.exit(1);
}

const DEADLINE_MS = 30_000;
const SENTINEL = `sk-stopd-sentinel-${randomUUID()}`;
const results = [];
const delays = {};
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};
/** Polls `fn` until it answers `true` (or the deadline); the answer, and the time it took. */
const waitFor = async (fn, timeout = DEADLINE_MS) => {
    const started = Date.now();
    let last;
    while (Date.now() - started < timeout) {
        last = await fn().catch((error) => String(error));
        if (last === true) return { ok: true, ms: Date.now() - started };
        await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false, ms: Date.now() - started, last };
};
/** A convergence check whose delay is recorded under `name`. */
const converges = async (name, fn) => {
    const result = await waitFor(fn);
    if (result.ok) delays[name] = result.ms;
    check(name, result.ok, result.last);
    return result.ok;
};

// The mock provider (OpenAI-compatible: a streamed request gets an SSE stream, a buffered one the same
// reply as JSON); it records the Authorization of every request.
const upstream = [];
const provider = http.createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    upstream.push({ authorization: req.headers.authorization ?? null, stream: !!body.stream });
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Stop D mock reply." } }] }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of ["Stop D ", "mock ", "reply."]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 300));
    }
    res.write("data: [DONE]\n\n");
    res.end();
});
await new Promise((r) => provider.listen(0, "0.0.0.0", () => r()));
const providerBase = `http://${providerHost}:${provider.address().port}`;

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const pageErrors = [];
const blockedAll = [];
let auth = null;
let epoch = null;

// Every byte either browser sent or received, for the sentinel check. A response body the browser
// cannot hand back (other than a redirect, a 204, or a 304) is recorded as missing.
const traffic = [];
const missingBodies = [];
const pendingBodies = new Set();

/** A client: its own context (its own browser storage and key pair) on the same server. */
async function client(label) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    blockedAll.push(await isolateContext(context));
    const page = await context.newPage();
    const state = { label, page, navigations: 0, batches: [], noticeSeen: false };
    page.on("pageerror", (e) => pageErrors.push(`${label}: ${String(e).slice(0, 300)}`));
    page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) state.navigations += 1;
    });
    page.on("request", (r) => {
        const h = r.headers();
        if (h["risu-auth"]) auth = h["risu-auth"];
        if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
        traffic.push(`${label} ${r.method()} ${r.url()} ${JSON.stringify(h)} ${r.postData() ?? ""}`);
        if (r.method() === "POST" && new URL(r.url()).pathname === "/api/resources/batch") {
            state.batches.push({ at: Date.now(), body: (r.postData() ?? "").slice(0, 300) });
        }
    });
    page.on("response", (r) => {
        const e = r.headers()["x-resource-epoch"];
        if (e) epoch = e;
        traffic.push(`${label} response ${r.status()} ${r.url()} ${JSON.stringify(r.headers())}`);
        const status = r.status();
        if ((status >= 300 && status < 400) || status === 204) return;
        const url = `${label} ${status} ${r.url()}`;
        const navigationsAtResponse = state.navigations;
        const read = r
            .body()
            .then((buffer) => traffic.push(`${label} body ${r.url()} ${buffer.toString("latin1")}`))
            .catch((error) => {
                // The page's own navigation discards a body it never read; anything else is missing.
                if (state.navigations === navigationsAtResponse) {
                    missingBodies.push(`${label} ${status} ${r.url()} ${String(error).slice(0, 120)}`);
                }
            })
            .finally(() => pendingBodies.delete(read));
        read.url = url;
        read.lostToNavigation = () => state.navigations > navigationsAtResponse;
        pendingBodies.add(read);
    });
    page.on("websocket", (ws) => {
        ws.on("framesent", (f) => traffic.push(`${label} ws> ${ws.url()} ${f.payload}`));
        ws.on("framereceived", (f) => traffic.push(`${label} ws< ${ws.url()} ${f.payload}`));
    });
    const settingsButton = page.locator("button:has(svg.lucide-settings)").first();
    const welcome = page.getByText("Welcome to Risuai!");
    // Waits for the app to sign in (answering a password prompt), without navigating.
    state.ready = async () => {
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (await settingsButton.isVisible().catch(() => false)) return;
            if (
                await page
                    .locator("button:has(svg.lucide-list)")
                    .isVisible()
                    .catch(() => false)
            )
                return;
            if (auth && (await welcome.isVisible().catch(() => false))) return;
            const input = page.locator("input:visible").first();
            const ok = page.getByRole("button", { name: "OK", exact: true });
            if ((await ok.count()) > 0 && (await input.count()) > 0) {
                await input.fill(password);
                await ok.first().click();
            }
            await page.waitForTimeout(300);
        }
        throw new Error(`${label}: the app did not load`);
    };
    state.open = async () => {
        await page.goto(base);
        await state.ready();
    };
    state.bodyText = () => page.evaluate(() => document.body.innerText);
    return state;
}

const api = async (p, init = {}) => {
    const r = await fetch(base + p, {
        ...init,
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
    });
    const e = r.headers.get("x-resource-epoch");
    const body = await r.json().catch(() => null);
    return { status: r.status, body, epoch: e };
};
const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;
const post = (p, body) => api(p, { method: "POST", body: JSON.stringify(body) });
const healthy = async () => {
    try {
        const r = await fetch(`${base}/api/test_auth`);
        return r.status > 0;
    } catch {
        return false;
    }
};

const description = (page) =>
    page.locator('xpath=//span[starts-with(normalize-space(.), "Description")]/following::textarea[1]').first();

/**
 * Selects the character in the sidebar, opens its chat, and opens its editor (the chat screen stays
 * beside it). From home the character lands on its closed-chat screen and "Open most recent chat"
 * opens the chat; after the app's own reload (a restore) the URL (`/chat/:chaId/:chatId`) has opened
 * it already. Nothing else is open before, so the two cases do not race.
 */
async function openCharacter(c, chaId) {
    if (
        !(await c.page
            .locator(`[data-char-id="${chaId}"]`)
            .first()
            .isVisible()
            .catch(() => false))
    ) {
        await c.page
            .locator("button:has(svg.lucide-list)")
            .first()
            .click()
            .catch(() => {});
    }
    await c.page.locator(`[data-char-id="${chaId}"]`).first().waitFor({ timeout: 60_000 });
    await c.page.locator(`[data-char-id="${chaId}"]`).first().click();
    const openChat = c.page.getByRole("button", { name: /Open most recent chat/ });
    await openChat.or(c.page.locator("textarea.input-text")).first().waitFor({ timeout: 15_000 });
    if (await openChat.isVisible()) {
        await openChat.click();
    }
    await c.page.waitForTimeout(1000);
    await c.page.getByRole("button", { name: "Character", exact: true }).first().click();
    await description(c.page).waitFor({ timeout: 15_000 });
}
/** Appends `text` to the description in `c`'s editor (typed, as a user types). */
async function typeDescription(c, text) {
    await description(c.page).click();
    await c.page.keyboard.press("End");
    await c.page.keyboard.type(text, { delay: 30 });
}
const storedCharacter = async (chaId) => (await api(`/api/resources/characters/${chaId}`)).body?.data;
const storedChat = async (chaId, chatId) =>
    (await post("/api/resources/read", { chats: [{ characterId: chaId, id: chatId }] })).body?.chats?.[0];
/** Appends a message through the routes (the third writer), on the chat's current revision. */
async function appendByRoute(chaId, chatId, data) {
    const chat = await storedChat(chaId, chatId);
    return post("/api/resources/batch", {
        chats: [
            {
                characterId: chaId,
                chatId,
                baseRevision: chat.revision,
                ops: [
                    { op: "append", messages: [{ role: "char", data, chatId: randomUUID() }], anchor: { end: true } },
                ],
            },
        ],
    });
}
/** Waits for the restore notice in each client, acknowledges it, and waits for the reload and sign-in. */
async function toldAndReloaded(name, clients) {
    for (const c of clients) {
        const before = c.navigations;
        const notice = c.page.getByText("restored from a backup");
        const told = await waitFor(async () => (await notice.count()) > 0);
        check(`${name}: ${c.label} is told`, told.ok, told.last);
        if (told.ok) {
            delays[`${name}: ${c.label} told`] = told.ms;
            await c.page.getByRole("button", { name: "OK", exact: true }).first().click();
        }
        const reloaded = await waitFor(async () => c.navigations > before);
        check(`${name}: ${c.label} reloads`, reloaded.ok, reloaded.last);
        await c.ready();
        await c.page.waitForTimeout(2000);
    }
}

try {
    // First run: A sets the password of the fresh server.
    const A = await client("A");
    await A.open();
    await A.page.waitForTimeout(1500);
    check("first run: A signed in on a fresh server", !!auth, auth);

    // Seed through the routes: setup done, the preset on the mock provider, a character with a chat.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const presets = await single("presets");
    const modelPresets = await single("modelPresets");
    const modelProfiles = await single("modelProfiles");
    const personas = await single("personas");
    const preset = {
        ...presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: `${providerBase}/v1/chat/completions`,
        customProxyRequestModel: "mock",
        maxContext: 900,
        maxResponse: 100,
    };
    const order = await single("characterOrder");
    const credentials = await single("credentials");
    const chaId = randomUUID();
    const chatId = `${chaId}-chat`;
    const seeded = await post("/api/resources/batch", {
        ops: [
            {
                kind: "credentials",
                id: "main",
                baseRevision: credentials.revision,
                data: [...credentials.data, { id: "stop-d-key", name: "Stop D key", type: "custom" }],
            },
            ...modelFixtureOps(
                { ...preset, customTokenizer: "tik", credentialId: "stop-d-key" },
                modelPresets,
                modelProfiles,
            ),
            {
                kind: "ui",
                id: "main",
                baseRevision: ui.revision,
                data: { ...ui.data, didFirstSetup: true, useLegacyGUI: true },
            },
            {
                kind: "presets",
                id: "main",
                baseRevision: presets.revision,
                data: [promptFixture(preset), ...presets.data.slice(1)],
            },
            {
                kind: "characters",
                id: chaId,
                baseRevision: null,
                data: { chaId, name: "Stop D", type: "character", desc: "Seeded.", firstMessage: "Greetings." },
            },
            {
                kind: "characterOrder",
                id: "main",
                baseRevision: order.revision,
                data: [...(Array.isArray(order.data) ? order.data : []), chaId],
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
                            name: "Chat 1",
                            message: [{ role: "char", data: "Greetings.", chatId: randomUUID() }],
                            // Bound: a send refuses an unbound chat (`docs/plan/chat-binding.md`).
                            ...chatBindingFixture(modelPresets, presets, personas),
                        },
                    },
                ],
            },
        ],
    });
    check("seed: stored", seeded.status === 200, seeded);
    // The sentinel credential, written through the public route (the browser never holds it).
    const secrets = await single("llmSecrets");
    const keyed = await api("/api/llm-secrets/credentials/~stop-d-key/key", {
        method: "PUT",
        body: JSON.stringify({ value: SENTINEL, baseRevision: secrets.revision }),
    });
    check("seed: the sentinel credential is set through the llmSecrets route", keyed.status === 200, keyed);

    // Two browsers: B logs in with the password (its own key pair), both open the character.
    await A.open();
    await openCharacter(A, chaId);
    const B = await client("B");
    await B.open();
    await openCharacter(B, chaId);
    check(
        "two browsers: both show the seeded character",
        (await description(A.page).inputValue()) === "Seeded." &&
            (await description(B.page).inputValue()) === "Seeded.",
    );

    // A → B and B → A, typed in the UI.
    await typeDescription(A, " A1.");
    await converges("converge: A's edit is stored", async () => (await storedCharacter(chaId))?.desc === "Seeded. A1.");
    await converges(
        "converge: B shows A's edit without a reload",
        async () => (await description(B.page).inputValue()) === "Seeded. A1.",
    );
    await typeDescription(B, " B1.");
    await converges(
        "converge: B's edit is stored",
        async () => (await storedCharacter(chaId))?.desc === "Seeded. A1. B1.",
    );
    await converges(
        "converge: A shows B's edit without a reload",
        async () => (await description(A.page).inputValue()) === "Seeded. A1. B1.",
    );
    await A.page.waitForTimeout(1500);

    // The third writer: a chat append through the routes; both show it, and neither writes back.
    const batchesBefore = { A: A.batches.length, B: B.batches.length };
    const appended = await appendByRoute(chaId, chatId, "Third writer message.");
    check("third writer: the append is stored", appended.status === 200, appended);
    await converges("converge: A shows the third writer's message", async () =>
        (await A.bodyText()).includes("Third writer message."),
    );
    await converges("converge: B shows the third writer's message", async () =>
        (await B.bodyText()).includes("Third writer message."),
    );
    await A.page.waitForTimeout(2000);
    check(
        "third writer: no client wrote back",
        A.batches.length === batchesBefore.A && B.batches.length === batchesBefore.B,
        {
            A: A.batches.slice(batchesBefore.A),
            B: B.batches.slice(batchesBefore.B),
        },
    );

    // A send as a server job; the sentinel reaches the provider and nowhere in the browsers' traffic.
    const input = A.page.locator("textarea.input-text").first();
    await input.fill("Hello from A.");
    await input.press("Enter");
    await converges("send: A shows the reply", async () => (await A.bodyText()).includes("Stop D mock reply."));
    await converges("send: B shows the reply", async () => (await B.bodyText()).includes("Stop D mock reply."));
    await converges("send: the user message and the reply are stored", async () => {
        const messages = (await storedChat(chaId, chatId))?.data?.message ?? [];
        return (
            (messages.some((m) => m.role === "user" && m.data === "Hello from A.") &&
                messages.at(-1)?.role === "char" &&
                messages.at(-1)?.data === "Stop D mock reply.") ||
            JSON.stringify({ messages: messages.map((m) => [m.role, m.data]), upstream })
        );
    });
    check(
        "send: the provider received the sentinel credential",
        upstream.some((u) => u.authorization === `Bearer ${SENTINEL}`),
        upstream,
    );
    // Drain the body reads; one still open after 10 s (a response that never ends) is reported.
    await Promise.race([Promise.allSettled([...pendingBodies]), new Promise((r) => setTimeout(r, 10_000))]);
    // A read the page's own navigation cut off (the app reloads when `/sw/init` answers before the
    // service worker controls the page) is reported, not failed: the page never read that body either.
    const lostToNavigation = [];
    for (const read of pendingBodies) {
        if (read.lostToNavigation()) lostToNavigation.push(read.url);
        else missingBodies.push(`${read.url} (still open)`);
    }
    if (lostToNavigation.length > 0) console.log("response bodies cut off by a page navigation", lostToNavigation);
    const leaks = traffic.filter((line) => line.includes(SENTINEL)).map((line) => line.slice(0, 300));
    check("send: the sentinel appears nowhere in either browser's traffic", leaks.length === 0, leaks);
    check("send: every response body was captured", missingBodies.length === 0, missingBodies);

    // Restart: the stored state survives, a write made before the clients reconnect reaches them.
    const beforeRestart = {
        desc: (await storedCharacter(chaId))?.desc,
        messages: ((await storedChat(chaId, chatId))?.data?.message ?? []).map((m) => m.data),
    };
    const navigations = { A: A.navigations, B: B.navigations };
    await promisify(exec)(restartCmd);
    const up = await waitFor(healthy, 60_000);
    check("restart: the server is healthy again", up.ok, up.last);
    const afterWrite = await appendByRoute(chaId, chatId, "Written after the restart.");
    check("restart: a route write right after it is stored", afterWrite.status === 200, afterWrite);
    const afterRestart = {
        desc: (await storedCharacter(chaId))?.desc,
        messages: ((await storedChat(chaId, chatId))?.data?.message ?? []).map((m) => m.data),
    };
    check(
        "restart: the state before it is stored after it",
        afterRestart.desc === beforeRestart.desc &&
            JSON.stringify(afterRestart.messages.slice(0, beforeRestart.messages.length)) ===
                JSON.stringify(beforeRestart.messages),
        { beforeRestart, afterRestart },
    );
    await converges("restart: A shows the write at its reconnect", async () =>
        (await A.bodyText()).includes("Written after the restart."),
    );
    await converges("restart: B shows the write at its reconnect", async () =>
        (await B.bodyText()).includes("Written after the restart."),
    );
    check("restart: neither client reloaded", A.navigations === navigations.A && B.navigations === navigations.B, {
        navigations,
        A: A.navigations,
        B: B.navigations,
    });
    check(
        "restart: no reload notice",
        !(await A.bodyText()).includes("The latest version was loaded") &&
            !(await B.bodyText()).includes("The latest version was loaded"),
    );
    await typeDescription(A, " A2.");
    await converges("restart: A's next edit is stored", async () =>
        (await storedCharacter(chaId))?.desc?.endsWith(" A2."),
    );
    await A.page.waitForTimeout(1500);

    // Archive: exported in S1, a change (S2), imported: both clients show S1 again.
    const exported = await fetch(`${base}/api/backups/export`, {
        method: "POST",
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        body: "{}",
    });
    const archive = Buffer.from(await exported.arrayBuffer());
    check("archive: exported", exported.status === 200 && archive.length > 0, exported.status);
    const s1 = (await storedChat(chaId, chatId))?.data?.message?.map((m) => m.data) ?? [];
    const s2Write = await appendByRoute(chaId, chatId, "S2 marker.");
    check("archive: the S2 change is stored", s2Write.status === 200, s2Write);
    await converges("archive: A shows the S2 change", async () => (await A.bodyText()).includes("S2 marker."));
    const listedBefore = new Set(((await api("/api/backups")).body?.items ?? []).map((item) => item.id));
    const imported = await fetch(`${base}/api/backups/import`, {
        method: "POST",
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/octet-stream" },
        body: archive,
    });
    const importedBody = await imported.json().catch(() => null);
    check("archive: imported", imported.status === 200 && !!importedBody?.epoch, importedBody);
    epoch = importedBody?.epoch ?? epoch;
    await toldAndReloaded("archive", [A, B]);
    const afterImport = (await storedChat(chaId, chatId))?.data?.message?.map((m) => m.data) ?? [];
    check("archive: the server holds S1", JSON.stringify(afterImport) === JSON.stringify(s1), { s1, afterImport });
    for (const c of [A, B]) {
        await openCharacter(c, chaId);
        await converges(`archive: ${c.label} shows S1`, async () => {
            const text = await c.bodyText();
            return text.includes("Written after the restart.") && !text.includes("S2 marker.");
        });
    }
    await typeDescription(B, " B2.");
    await converges("archive: B's next edit is stored", async () =>
        (await storedCharacter(chaId))?.desc?.endsWith(" B2."),
    );
    await B.page.waitForTimeout(1500);

    // Snapshot restore: the one snapshot the import added (its safety snapshot of S2), restored by id.
    const listedAfter = ((await api("/api/backups")).body?.items ?? []).map((item) => item.id);
    const added = listedAfter.filter((id) => !listedBefore.has(id));
    check("snapshot: the import added exactly one snapshot", added.length === 1, { added, listedAfter });
    const restored = await post(`/api/backups/${encodeURIComponent(added[0] ?? "none")}/restore`, {});
    check("snapshot: restored by id", restored.status === 200 && !!restored.body?.epoch, restored);
    epoch = restored.body?.epoch ?? epoch;
    await toldAndReloaded("snapshot", [A, B]);
    const afterRestore = (await storedChat(chaId, chatId))?.data?.message?.map((m) => m.data) ?? [];
    check("snapshot: the server holds S2", afterRestore.at(-1) === "S2 marker.", afterRestore);
    for (const c of [A, B]) {
        await openCharacter(c, chaId);
        await converges(`snapshot: ${c.label} shows S2`, async () => (await c.bodyText()).includes("S2 marker."));
    }
    await typeDescription(A, " A3.");
    await converges("snapshot: A's next edit is stored", async () =>
        (await storedCharacter(chaId))?.desc?.endsWith(" A3."),
    );

    const egress = unexpectedEgress(blockedAll.flat(), []);
    check("no unexpected outbound request", egress.length === 0, egress);
    check("no page error", pageErrors.length === 0, pageErrors);
    console.log("observed delays (ms)", delays);
} catch (error) {
    console.error(error);
    results.push(false);
} finally {
    await browser.close();
    provider.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
