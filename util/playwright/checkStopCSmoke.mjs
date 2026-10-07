// The Phase 6 Stop C Docker smoke (lazy chats, slice 9b), against the built app (the Docker image on a
// fresh volume; the check sets its password), through the UI and the public API only (no dev
// modules). A character with 12 chats: the boot reads chat summaries only and no chat at home;
// opening the character reads its selected chat alone; each chat is read once when it is first
// opened; after eleven switches the least recently used chats are evicted (opening one reads it
// again) and a recent one is not (no read); a second client converges on another writer's rename of
// a chat it has not loaded through the summary list, without a chat read; nothing is written by
// opening, switching, or reloading.
//
// Usage: node util/playwright/checkStopCSmoke.mjs --base http://localhost:6246 --password docker-pw
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, unexpectedEgress } from "./stack.mjs";

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const base = option("--base");
const password = option("--password") ?? "docker-pw";
if (!base) {
    console.error("Usage: node util/playwright/checkStopCSmoke.mjs --base <url> [--password <pw>]");
    process.exit(1);
}

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const pageErrors = [];
const blockedAll = [];
let auth = null;
let epoch = null;

/**
 * A client: its own context (its own browser storage) on the same server, with its resource
 * traffic recorded: the boot queries, the chat ids each read asked for (whole chats, summary lists),
 * and the batches it posted.
 */
async function client(label) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    blockedAll.push(await isolateContext(context));
    const page = await context.newPage();
    const traffic = { boots: [], chats: [], summaries: [], batches: 0 };
    page.on("pageerror", (e) => pageErrors.push(`${label}: ${String(e).slice(0, 300)}`));
    page.on("request", (r) => {
        const h = r.headers();
        if (h["risu-auth"]) auth = h["risu-auth"];
        if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
        const url = new URL(r.url());
        if (r.method() === "GET" && url.pathname === "/api/resources") traffic.boots.push(url.search);
        if (r.method() === "POST" && url.pathname === "/api/resources/read") {
            const body = JSON.parse(r.postData() ?? "{}");
            traffic.chats.push(...(body.chats ?? []).map((ref) => ref.id));
            traffic.summaries.push(...(body.chatSummaryCollections ?? []));
        }
        if (r.method() === "POST" && url.pathname === "/api/resources/batch") traffic.batches++;
    });
    const welcome = page.getByText("Welcome to Risuai!");
    const open = async () => {
        await page.goto(base);
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            if (
                await page
                    .locator("button:has(svg.lucide-settings)")
                    .first()
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
    const reset = () => {
        traffic.boots.length = 0;
        traffic.chats.length = 0;
        traffic.summaries.length = 0;
        traffic.batches = 0;
    };
    return { page, open, traffic, reset };
}

const api = async (p, init = {}) => {
    const r = await fetch(base + p, {
        ...init,
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;

const CHATS = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, name: `Chat ${i}`, count: i === 0 ? 40 : 3 }));
const shown = (c, chatId, count) =>
    c.page
        .getByText(`Message ${chatId}-${count - 1}.`, { exact: true })
        .first()
        .waitFor({ timeout: 20_000 });

/** Selects the character in the sidebar (its selected chat shows). */
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
    const handle = await c.page.locator(`[data-char-id="${chaId}"]`).first().elementHandle();
    await c.page.evaluate((avatar) => (avatar.closest('[role="button"]') ?? avatar).click(), handle);
}

/** Opens a chat from the character's chat list and waits until its last message shows. */
async function openChat(c, chat) {
    await c.page
        .locator("button[data-risu-chat-idx]")
        .filter({ has: c.page.getByText(chat.name, { exact: true }) })
        .first()
        .click();
    await shown(c, chat.id, chat.count);
    // The trim runs after the load (a zero-delay timer).
    await c.page.waitForTimeout(300);
}

try {
    const A = await client("A");
    await A.open();
    await A.page.waitForTimeout(1500);

    // Seed through the routes: setup done, the legacy GUI, one character with 12 chats.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const order = await single("characterOrder");
    const chaId = randomUUID();
    const message = (chatId, i) => ({
        role: i % 2 === 0 ? "user" : "char",
        data: `Message ${chatId}-${i}.`,
        chatId: randomUUID(),
    });
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, didFirstSetup: true, useLegacyGUI: true },
                },
                {
                    kind: "characters",
                    id: chaId,
                    baseRevision: null,
                    data: { chaId, name: "Lazy", type: "character", firstMessage: "Hello." },
                },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...(Array.isArray(order.data) ? order.data : []), chaId],
                },
            ],
            chats: CHATS.map((chat) => ({
                characterId: chaId,
                chatId: chat.id,
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: chat.id,
                            name: chat.name,
                            message: Array.from({ length: chat.count }, (_, i) => message(chat.id, i)),
                        },
                    },
                ],
            })),
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded);

    // The boot: chat summaries, no chat; nothing read at home.
    A.reset();
    await A.open();
    await A.page.waitForTimeout(2500);
    check(
        "boot: the resource read asks for chat summaries, not chats",
        A.traffic.boots.length > 0 &&
            A.traffic.boots.every((q) => q.includes("chatSummaries=1") && !q.includes("chats=1")),
        A.traffic.boots,
    );
    check("boot: no chat read at home", A.traffic.chats.length === 0, A.traffic.chats);

    // Opening the character reads its selected chat (the first) alone.
    await openCharacter(A, chaId);
    await shown(A, "c0", 40);
    await A.page.waitForTimeout(500);
    check("open: the selected chat alone is read", JSON.stringify(A.traffic.chats) === '["c0"]', A.traffic.chats);

    // Each other chat is read once, when it is first opened.
    for (const chat of CHATS.slice(1)) {
        await openChat(A, chat);
    }
    check(
        "switch: each chat read once, in the order opened",
        JSON.stringify(A.traffic.chats) === JSON.stringify(CHATS.map((chat) => chat.id)),
        A.traffic.chats,
    );

    // Eight idle chats stay loaded beside the selected one (c11): c3..c10. A recent one opens
    // without a read; the least recently used was evicted and is read again.
    A.traffic.chats.length = 0;
    await openChat(A, CHATS[10]);
    check("evict: a recent chat opens without a read", A.traffic.chats.length === 0, A.traffic.chats);
    await openChat(A, CHATS[0]);
    check(
        "evict: the least recently used chat is read again",
        JSON.stringify(A.traffic.chats) === '["c0"]',
        A.traffic.chats,
    );
    check("switch: opening and switching wrote nothing", A.traffic.batches === 0, A.traffic.batches);

    // A second client opens the character (its selected chat only); another writer renames a chat
    // B has not loaded: B's list shows the new name through the summary list, with no chat read.
    const B = await client("B");
    await B.open();
    await openCharacter(B, chaId);
    await shown(B, "c0", 40);
    await B.page.waitForTimeout(500);
    check(
        "second client: its selected chat alone is read",
        JSON.stringify(B.traffic.chats) === '["c0"]',
        B.traffic.chats,
    );
    B.reset();
    const before = (
        await api("/api/resources/read", {
            method: "POST",
            body: JSON.stringify({ chatSummaryCollections: [chaId] }),
        })
    ).body;
    const c5 = before?.chatSummaryCollections?.[0]?.chats?.find((chat) => chat.id === "c5");
    const renamed = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [],
            chats: [
                {
                    characterId: chaId,
                    chatId: "c5",
                    baseRevision: c5?.revision ?? null,
                    ops: [{ op: "meta", set: { name: "Chat 5 renamed" } }],
                },
            ],
            chatOrders: [],
        }),
    });
    check("rename: stored by another writer", renamed.status === 200, renamed);
    const converged = await B.page
        .locator("button[data-risu-chat-idx]")
        .filter({ has: B.page.getByText("Chat 5 renamed", { exact: true }) })
        .first()
        .waitFor({ timeout: 20_000 })
        .then(() => true)
        .catch(() => false);
    check("rename: the second client's list shows it", converged);
    check(
        "rename: through the summary list, with no chat read",
        B.traffic.chats.length === 0 && B.traffic.summaries.includes(chaId),
        B.traffic,
    );
    check("second client: wrote nothing", B.traffic.batches === 0, B.traffic.batches);

    // An idle reload writes nothing.
    A.reset();
    await A.open();
    await A.page.waitForTimeout(2500);
    await openCharacter(A, chaId);
    await shown(A, "c0", 40);
    await A.page.waitForTimeout(2500);
    check("reload: opening and reading wrote nothing", A.traffic.batches === 0, A.traffic.batches);

    const egress = unexpectedEgress(blockedAll.flat(), []);
    check("no unexpected outbound request", egress.length === 0, egress);
    check("no page error", pageErrors.length === 0, pageErrors);
} catch (error) {
    console.error(error);
    results.push(false);
} finally {
    await browser.close();
}

const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed === 0 ? 0 : 1);
