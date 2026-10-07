// Browser check for Phase 6 slice 2 (live updates, Stop A's two-tab matrix on the flat mirror):
// two tabs of one browser (A1, A2) and a second browser (B) against one dev stack. Writes made in a
// tab, and through the routes as another device would, reach the other tabs without a reload,
// without the `resourceReloaded` notice, and without a write back: a new character with its chat, a
// settings edit, a character edit, a preset edit, a chat rename, a message edit, an appended
// message, a new chat, a deleted chat, and a deleted character. The preset selection stays per
// client. A server send in A1 shows its
// checkpoint and its final text in A2 and B. After a server restart with changes made right away,
// every tab reconnects and reconciles. An imported archive (a restore) reloads every tab.
//
// Usage: node util/playwright/checkLiveUpdates.mjs   (dev only: it reads the tabs' state through
// the dev server's modules).
import http from "node:http";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, openApp, startStack, unexpectedEgress } from "./stack.mjs";

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

// The provider: a streamed request streams `mode.chunks`, `mode.delayMs` apart.
let mode = { chunks: ["Mock ", "reply."], delayMs: 50 };
const provider = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of mode.chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, mode.delayMs));
    }
    res.write("data: [DONE]\n\n");
    res.end();
});
await new Promise((r) => provider.listen(0, "127.0.0.1", () => r()));
const providerBase = `http://127.0.0.1:${provider.address().port}`;

const stack = await startStack({
    serverPort: 6241,
    vitePort: 5341,
    log: process.env.DEBUG ? (text) => process.stderr.write(text) : undefined,
});
const base = stack.baseURL;
const browser = await chromium.launch({ executablePath: chromePath, headless: true });

const blank = (chaId, name, extra = {}) => ({
    name,
    firstMessage: "Greetings.",
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
});
const message = (chatId, role, data) => ({ role, data, chatId, saying: "", time: Date.now() });
const chat = (id, name, messages) => ({ id, name, note: "", localLore: [], message: messages });

const waitFor = async (fn, ms = 15000) => {
    const until = Date.now() + ms;
    let last;
    while (Date.now() < until) {
        last = await fn().catch((error) => ({ error: String(error) }));
        if (last === true) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return last;
};

try {
    const contextA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const blocked = [...(await isolateContext(contextA)), ...(await isolateContext(contextB))];
    const pageErrors = [];
    const requests = [];
    let auth = null;
    let epoch = null;
    const watch = (p, label) => {
        p.on("pageerror", (e) => pageErrors.push(`${label}: ${String(e).slice(0, 300)}`));
        p.on("request", (r) => {
            const h = r.headers();
            if (h["risu-auth"]) auth = h["risu-auth"];
            if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
            requests.push({ page: label, method: r.method(), path: new URL(r.url()).pathname, at: Date.now() });
        });
    };
    const api = async (p, init = {}) => {
        const r = await fetch(base + p, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: r.status, body: await r.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;
    const batch = (body) => api("/api/resources/batch", { method: "POST", body: JSON.stringify(body) });
    const chatRevision = async (chaId, chatId) =>
        (
            await api("/api/resources/read", {
                method: "POST",
                body: JSON.stringify({ chats: [{ characterId: chaId, id: chatId }] }),
            })
        ).body?.chats?.[0]?.revision ?? null;
    const record = async (kind, id) => (await api(`/api/resources/${kind}/${encodeURIComponent(id)}`)).body;

    // State of a tab, through the dev server's modules (the same instances the app uses).
    const state = (p, fn, arg) => p.evaluate(fn, arg);
    // A character with its chats in list order. Chats load on demand (Phase 6 slice 9b): each listed
    // chat is loaded as a reader showing it would (once; afterwards the held copy is what live
    // updates refresh).
    const charOf = (p, chaId) =>
        state(
            p,
            async (id) => {
                const { DBState } = await import("/src/ts/stores.svelte.ts");
                const { chatList, ensureChatLoaded } = await import("/src/ts/storage/chatStore.svelte.ts");
                const c = DBState.db.characters.find((entry) => entry?.chaId === id);
                if (!c) {
                    return null;
                }
                const chats = [];
                for (const entry of chatList(id)) {
                    const chat = await ensureChatLoaded({ chaId: id, chatId: entry.id });
                    if (chat) {
                        chats.push(chat);
                    }
                }
                return JSON.parse(JSON.stringify({ ...c, chats }));
            },
            chaId,
        );
    const notices = (p) =>
        state(p, async () => (document.body.innerText.includes("Another tab or device changed this data") ? 1 : 0));
    const batchesSince = (label, since) =>
        requests.filter((r) => r.page === label && r.path === "/api/resources/batch" && r.at >= since).length;

    const A1 = await contextA.newPage();
    watch(A1, "A1");
    await openApp(A1, base);
    await A1.waitForTimeout(1500);

    // Seed through the routes (another device): setup done, a mock-provider preset, a second preset.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const presets = await single("presets");
    const providers = await single("providers");
    const preset = {
        ...presets.data[0],
        name: "Preset One",
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: `${providerBase}/v1/chat/completions`,
        customProxyRequestModel: "mock",
        maxContext: 900,
        maxResponse: 100,
    };
    const second = { ...preset, id: randomUUID(), name: "Preset Two", temperature: 30 };
    let seeded = await batch({
        ops: [
            { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
            { kind: "presets", id: "main", baseRevision: presets.revision, data: [preset, second] },
            {
                kind: "providers",
                id: "main",
                baseRevision: providers.revision,
                data: { ...providers.data, useStreaming: true, customTokenizer: "tik" },
            },
        ],
    });
    check("seed: settings stored", seeded.status === 200, seeded);

    const A2 = await contextA.newPage();
    watch(A2, "A2");
    const B = await contextB.newPage();
    watch(B, "B");
    await openApp(A2, base);
    await openApp(B, base);
    await A2.waitForTimeout(1500);
    await B.waitForTimeout(1500);
    const tabs = [
        ["A1", A1],
        ["A2", A2],
        ["B", B],
    ];

    // 1. A new character with its chat, written through the routes, reaches every open tab.
    const liaId = randomUUID();
    const order = await single("characterOrder");
    let since = Date.now();
    seeded = await batch({
        ops: [
            { kind: "characters", id: liaId, baseRevision: null, data: blank(liaId, "Live Lia") },
            { kind: "characterOrder", id: "main", baseRevision: order.revision, data: [...order.data, liaId] },
        ],
        chats: [
            {
                characterId: liaId,
                chatId: "k",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: chat("k", "Chat K", [message("m1", "char", "Hello one."), message("m2", "user", "Hi.")]),
                    },
                ],
            },
        ],
    });
    check("new character: stored", seeded.status === 200, seeded);
    for (const [label, p] of tabs) {
        const ok = await waitFor(async () => {
            const c = await charOf(p, liaId);
            return c?.name === "Live Lia" && c.chats?.[0]?.message?.map((m) => m.data).join("|") === "Hello one.|Hi.";
        });
        check(`new character: ${label} shows it with its chat`, ok === true, ok);
    }

    // 2. A settings edit in A1 (the save loop writes it) reaches A2 and B.
    since = Date.now();
    await state(A1, async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        DBState.db.zoomsize = 110;
    });
    for (const [label, p] of [
        ["A2", A2],
        ["B", B],
    ]) {
        const ok = await waitFor(async () =>
            state(p, async () => (await import("/src/ts/stores.svelte.ts")).DBState.db.zoomsize === 110),
        );
        check(`settings edit: ${label} shows zoomsize 110`, ok === true, ok);
    }

    // 3. A character edit in B (the mutation module) reaches A1 and A2.
    await state(
        B,
        async (id) => {
            const { updateCharacter } = await import("/src/ts/storage/characterStore.svelte.ts");
            updateCharacter(id, { desc: "Edited in B." });
        },
        liaId,
    );
    for (const [label, p] of [
        ["A1", A1],
        ["A2", A2],
    ]) {
        const ok = await waitFor(async () => (await charOf(p, liaId))?.desc === "Edited in B.");
        check(`character edit: ${label} shows the new description`, ok === true, ok);
    }

    // 4. A preset edit in A1 through the forwarded field reaches B (same preset selected on both).
    await state(A1, async () => {
        const { DBState } = await import("/src/ts/stores.svelte.ts");
        DBState.db.temperature = 42;
    });
    const presetTemp = (p) =>
        state(p, async () => (await import("/src/ts/stores.svelte.ts")).DBState.db.botPresets[0]?.temperature);
    {
        const ok = await waitFor(async () => (await presetTemp(B)) === 42);
        check("preset edit: B's first preset has temperature 42", ok === true, ok);
    }

    // 5. A preset selection in B does not move A's; the translator selection (a shared record) does.
    await state(
        B,
        async (id) => {
            const { changeToPreset } = await import("/src/ts/storage/database.svelte.ts");
            changeToPreset(id);
        },
        second.id,
    );
    await B.waitForTimeout(2500);
    const selectedName = (p) =>
        state(p, async () => {
            const { DBState } = await import("/src/ts/stores.svelte.ts");
            return DBState.db.botPresets[DBState.db.botPresetsId]?.name;
        });
    check("selection: B switched to Preset Two", (await selectedName(B)) === "Preset Two", await selectedName(B));
    check("selection: A1 keeps Preset One", (await selectedName(A1)) === "Preset One", await selectedName(A1));

    // 6. Chat changes through the routes (another device): rename, message edit, append.
    let rev = await chatRevision(liaId, "k");
    since = Date.now();
    const chatEdit = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            chats: [
                {
                    characterId: liaId,
                    chatId: "k",
                    baseRevision: rev,
                    ops: [
                        { op: "meta", set: { name: "Renamed K" } },
                        { op: "setText", id: "m1", text: "Hello edited." },
                        { op: "append", messages: [message("m3", "char", "Appended.")], anchor: { end: true } },
                    ],
                },
            ],
        }),
    });
    check("chat edit: stored", chatEdit.status === 200, chatEdit);
    for (const [label, p] of tabs) {
        const ok = await waitFor(async () => {
            const c = await charOf(p, liaId);
            const k = c?.chats?.find((entry) => entry.id === "k");
            return k?.name === "Renamed K" && k.message.map((m) => m.data).join("|") === "Hello edited.|Hi.|Appended.";
        });
        check(`chat edit: ${label} shows the rename, the edit, and the appended message`, ok === true, ok);
    }

    // 7. A new chat, then the first chat deleted, through the routes.
    rev = await chatRevision(liaId, "k");
    const created = await batch({
        chats: [
            {
                characterId: liaId,
                chatId: "j",
                baseRevision: null,
                ops: [{ op: "create", chat: chat("j", "Chat J", [message("n1", "char", "Second chat.")]) }],
            },
        ],
    });
    check("new chat: stored", created.status === 200, created);
    for (const [label, p] of tabs) {
        const ok = await waitFor(
            async () => (await charOf(p, liaId))?.chats?.map((entry) => entry.id).join(",") === "k,j",
        );
        check(`new chat: ${label} lists k and j`, ok === true, ok);
    }
    rev = await chatRevision(liaId, "k");
    const deleted = await batch({
        chats: [{ characterId: liaId, chatId: "k", baseRevision: rev, ops: [{ op: "delete" }] }],
    });
    check("deleted chat: stored", deleted.status === 200, deleted);
    for (const [label, p] of tabs) {
        const ok = await waitFor(
            async () => (await charOf(p, liaId))?.chats?.map((entry) => entry.id).join(",") === "j",
        );
        check(`deleted chat: ${label} lists only j`, ok === true, ok);
    }

    // No tab saw the reload notice, and the routes-only changes (6, 7) were not written back.
    for (const [label, p] of tabs) {
        check(`no reload notice in ${label}`, (await notices(p)) === 0);
        check(
            `no write back from ${label} after the routes' chat changes`,
            batchesSince(label, since) === 0,
            batchesSince(label, since),
        );
    }

    // 8. A server send in A1: A2 and B show the reply at a checkpoint, then the final text.
    mode = { chunks: Array.from({ length: 16 }, (_, i) => `part${i} `), delayMs: 500 };
    await A1.locator(`[data-char-id="${liaId}"]`).first().click();
    await A1.getByText("Second chat.").first().waitFor({ timeout: 15000 });
    await A1.waitForTimeout(1000);
    const input = A1.locator("textarea.input-text").first();
    await input.fill("Tell me something.");
    await input.press("Enter");
    const lastText = (p) =>
        charOf(p, liaId).then((c) => c?.chats?.find((entry) => entry.id === "j")?.message?.at(-1)?.data ?? "");
    for (const [label, p] of [
        ["A2", A2],
        ["B", B],
    ]) {
        const ok = await waitFor(async () => {
            const text = await lastText(p);
            return text.startsWith("part0") && !text.includes("part15");
        }, 12000);
        check(`send: ${label} shows a checkpoint of the running reply`, ok === true, ok);
    }
    for (const [label, p] of [
        ["A2", A2],
        ["B", B],
    ]) {
        const ok = await waitFor(async () => (await lastText(p)).includes("part15"), 30000);
        check(`send: ${label} shows the final reply`, ok === true, ok);
    }

    // 9. A deleted character (through the routes) leaves every tab.
    const lia = await record("characters", liaId);
    const order2 = await single("characterOrder");
    const removed = await batch({
        ops: [
            { kind: "characters", id: liaId, baseRevision: lia.revision, delete: true },
            {
                kind: "characterOrder",
                id: "main",
                baseRevision: order2.revision,
                data: order2.data.filter((id) => id !== liaId),
            },
        ],
    });
    check("deleted character: stored", removed.status === 200, removed);
    for (const [label, p] of tabs) {
        const ok = await waitFor(async () => (await charOf(p, liaId)) === null);
        check(`deleted character: ${label} no longer holds it`, ok === true, ok);
    }

    // 10. A server restart, with changes made right after it: every tab reconnects and reconciles.
    await stack.restartServer();
    const ui2 = await single("ui");
    const miaId = randomUUID();
    const order3 = await single("characterOrder");
    const afterRestart = await batch({
        ops: [
            { kind: "ui", id: "main", baseRevision: ui2.revision, data: { ...ui2.data, zoomsize: 120 } },
            { kind: "characters", id: miaId, baseRevision: null, data: blank(miaId, "Restart Mia") },
            { kind: "characterOrder", id: "main", baseRevision: order3.revision, data: [...order3.data, miaId] },
        ],
        chats: [
            {
                characterId: miaId,
                chatId: "r",
                baseRevision: null,
                ops: [{ op: "create", chat: chat("r", "Chat R", [message("r1", "char", "After restart.")]) }],
            },
        ],
    });
    check("restart: changes stored right after it", afterRestart.status === 200, afterRestart);
    for (const [label, p] of tabs) {
        const ok = await waitFor(async () => {
            const zoom = await state(p, async () => (await import("/src/ts/stores.svelte.ts")).DBState.db.zoomsize);
            const c = await charOf(p, miaId);
            return zoom === 120 && c?.chats?.[0]?.message?.[0]?.data === "After restart.";
        }, 60000);
        check(`restart: ${label} reconciled both changes`, ok === true, ok);
    }

    // 11. An imported archive (a restore) reloads every tab.
    const exported = await fetch(base + "/api/backups/export", {
        method: "POST",
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        body: "{}",
    });
    const archive = Buffer.from(await exported.arrayBuffer());
    check("restore: an archive is exported", exported.status === 200 && archive.length > 0, exported.status);
    const reloads = new Map(tabs.map(([label]) => [label, 0]));
    for (const [label, p] of tabs) {
        p.on("dialog", (dialog) => dialog.accept().catch(() => {}));
        p.on("framenavigated", (frame) => {
            if (frame === p.mainFrame()) reloads.set(label, reloads.get(label) + 1);
        });
    }
    const imported = await fetch(base + "/api/backups/import", {
        method: "POST",
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/octet-stream" },
        body: archive,
    });
    check("restore: the archive is imported", imported.status === 200, imported.status);
    for (const [label, p] of tabs) {
        const ok = await waitFor(async () => {
            if (reloads.get(label) > 0) return true;
            // The restore notice waits for an OK before the reload.
            const okButton = p.getByRole("button", { name: "OK", exact: true });
            if ((await okButton.count()) > 0) await okButton.first().click();
            return false;
        }, 30000);
        check(`restore: ${label} reloads`, ok === true, ok);
    }

    const denied = await stack.deniedEgress();
    const unexpected = unexpectedEgress(blocked, denied);
    check("no unexpected outbound request", unexpected.length === 0, unexpected);
    check("no page error", pageErrors.length === 0, pageErrors);
} catch (error) {
    console.error(error);
    results.push(false);
} finally {
    await browser.close();
    await stack.stop();
    provider.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
