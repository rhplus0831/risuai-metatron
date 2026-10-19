// The Phase 6 Stop B Docker smoke (open, edit, reload, two tabs), for the records slices 4 and 5 made
// the source of truth: a settings edit (a nested section field, `NAIImgConfig.width`, typed into the
// NovelAI image settings) and a character edit (the description, typed into the character editor) are
// saved, survive a reload, and reach a second client without a reload. Run against the built app (the
// Docker image on a fresh volume; the check sets its password), through the UI and the public API only
// (no dev modules).
//
// Usage: node util/playwright/checkStopBSmoke.mjs --base http://localhost:6232 --password docker-pw
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
    console.error("Usage: node util/playwright/checkStopBSmoke.mjs --base <url> [--password <pw>]");
    process.exit(1);
}

const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};
const waitFor = async (fn, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        last = await fn().catch((error) => String(error));
        if (last === true) return true;
        await new Promise((r) => setTimeout(r, 300));
    }
    return last;
};

const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const pageErrors = [];
const blockedAll = [];
let auth = null;
let epoch = null;

/** A client: its own context (its own browser storage) on the same server. */
async function client(label) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    blockedAll.push(await isolateContext(context));
    const page = await context.newPage();
    page.on("pageerror", (e) => pageErrors.push(`${label}: ${String(e).slice(0, 300)}`));
    page.on("request", (r) => {
        const h = r.headers();
        if (h["risu-auth"]) auth = h["risu-auth"];
        if (h["x-resource-epoch"]) epoch = h["x-resource-epoch"];
    });
    const settingsButton = page.locator("button:has(svg.lucide-settings)").first();
    const welcome = page.getByText("Welcome to Risuai!");
    const open = async () => {
        await page.goto(base);
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
    return { page, open, settingsButton };
}

const api = async (p, init = {}) => {
    const r = await fetch(base + p, {
        ...init,
        headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
    });
    return { status: r.status, body: await r.json().catch(() => null) };
};
const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;

const description = (page) =>
    page.locator('xpath=//span[starts-with(normalize-space(.), "Description")]/following::textarea[1]').first();
const width = (page) =>
    page.locator('xpath=//span[normalize-space(.)="Width"]/following-sibling::*[1]/descendant-or-self::input').first();
const menu = (page, label) => page.locator(`button:has(> span:text-is("${label}"))`).first();

/** Selects the character in the sidebar and opens its editor. */
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
    await c.page.waitForTimeout(1000);
    await c.page.getByRole("button", { name: "Character", exact: true }).first().click();
    await description(c.page).waitFor({ timeout: 15_000 });
}

/** Opens the Image Generation page (the nested `NAIImgConfig` controls). */
async function openImageSettings(c) {
    if (!(await c.settingsButton.isVisible().catch(() => false))) {
        await c.page.locator("button:has(svg.lucide-list)").first().click();
    }
    await c.settingsButton.click();
    await c.page.waitForTimeout(500);
    await menu(c.page, "Image Generation").click();
    await width(c.page).waitFor({ timeout: 15_000 });
}

try {
    const A = await client("A");
    await A.open();
    await A.page.waitForTimeout(1500);

    // Seed through the routes: setup done, the legacy GUI, NovelAI images, one character with a chat.
    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const media = await single("memoryTranslateMedia");
    const order = await single("characterOrder");
    const chaId = randomUUID();
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
                    kind: "memoryTranslateMedia",
                    id: "main",
                    baseRevision: media.revision,
                    data: { ...media.data, sdProvider: "novelai" },
                },
                {
                    kind: "characters",
                    id: chaId,
                    baseRevision: null,
                    data: { chaId, name: "Smoke", type: "character", desc: "Seeded description." },
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
                    chatId: `${chaId}-chat`,
                    baseRevision: null,
                    ops: [{ op: "create", chat: { id: `${chaId}-chat`, name: "Chat 1", message: [] } }],
                },
            ],
            chatOrders: [],
        }),
    });
    check("seed: stored", seeded.status === 200, seeded);
    const stored = (await api(`/api/resources/characters/${chaId}`)).body?.data;
    check(
        "seed: the server normalized the character (slice 5b defaults)",
        stored?.firstMessage === "" && Array.isArray(stored?.globalLore) && stored?.ttsMode === "",
        stored,
    );

    // Open: A and B both show the character's editor.
    await A.open();
    await openCharacter(A, chaId);
    const B = await client("B");
    await B.open();
    await openCharacter(B, chaId);
    check(
        "open: both clients show the seeded description",
        (await description(A.page).inputValue()) === "Seeded description." &&
            (await description(B.page).inputValue()) === "Seeded description.",
    );

    // Edit (character): typed into A's editor; saved, and B shows it without a reload.
    await description(A.page).click();
    await A.page.keyboard.press("End");
    await A.page.keyboard.type(" Edited in A.", { delay: 30 });
    const edited = "Seeded description. Edited in A.";
    const savedChar = await waitFor(
        async () => (await api(`/api/resources/characters/${chaId}`)).body?.data?.desc === edited,
    );
    check("character edit: saved", savedChar === true, savedChar);
    const liveChar = await waitFor(async () => (await description(B.page).inputValue()) === edited);
    check("character edit: B shows it without a reload", liveChar === true, liveChar);

    // Edit (settings): the NovelAI width typed into A's image settings; saved, and B sees it.
    await openImageSettings(A);
    await width(A.page).fill("640");
    await width(A.page).press("Tab");
    const savedWidth = await waitFor(
        async () => (await single("memoryTranslateMedia"))?.data?.NAIImgConfig?.width === 640,
    );
    check("settings edit: saved", savedWidth === true, savedWidth);
    await openImageSettings(B);
    const liveWidth = await waitFor(async () => (await width(B.page).inputValue()) === "640");
    check("settings edit: B shows it", liveWidth === true, liveWidth);

    // Reload: A shows both edits from the server, and the reload writes nothing. (No key is pressed
    // here: `hotkeyMatches` writes a hotkey's missing modifier flags into the stored list on a key
    // press, a write the server's hotkey normalizer undoes, so the first key press of a session saves
    // `hotkeys`. That predates Phase 6; it is reported at Stop B.)
    let batches = 0;
    const written = [];
    A.page.on("request", (r) => {
        if (r.method() === "POST" && new URL(r.url()).pathname === "/api/resources/batch") {
            batches += 1;
            const body = JSON.parse(r.postData() ?? "{}");
            written.push({
                ops: (body.ops ?? []).map((op) => `${op.kind}/${op.id}`),
                chats: (body.chats ?? []).map((chat) => chat.ops?.map((op) => op.op)),
                data: (body.ops ?? []).map((op) => JSON.stringify(op.data)?.slice(0, 300)),
            });
        }
    });
    await A.open();
    await A.page.waitForTimeout(2500);
    await openCharacter(A, chaId);
    check("reload: the character edit survived", (await description(A.page).inputValue()) === edited);
    await openImageSettings(A);
    check("reload: the settings edit survived", (await width(A.page).inputValue()) === "640");
    await A.page.waitForTimeout(2500);
    check("reload: opening and reading wrote nothing", batches === 0, { batches, written });

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
