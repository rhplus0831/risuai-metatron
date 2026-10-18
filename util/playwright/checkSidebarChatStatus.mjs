// Browser check for sidebar chat status: idle pins, generating pins/characters/collapsed folders,
// open-folder aggregation, unseen completion away from the chat, home pinned-card badges and
// accessible names, Enter reopening/clearing, and a reply completed in the open chat staying seen.
// Also checks that badges add no tab stop, no page errors occur, and no unexpected intercepted
// egress is attempted. Recovery after a lost follow needs a manual server interruption.
//
// Usage:
//   node util/playwright/checkSidebarChatStatus.mjs
//       dev: starts an isolated stack on server 6231 / Vite 5331 (`stack.mjs`).
//   node util/playwright/checkSidebarChatStatus.mjs --base http://localhost:6197 --password docker-pw \
//       --provider-host host.docker.internal
//       production: an already running built app, preferably on a fresh volume. The mock provider
//       listens on every interface and is addressed by `--provider-host` from that server.
import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";
import { chromePath, isolateContext, openApp, startStack, unexpectedEgress } from "./stack.mjs";
import { chatBindingFixture, modelFixtureOps, promptFixture } from "./modelProfiles.mjs";

const args = process.argv.slice(2);
const option = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
};
const results = [];
const check = (name, ok, detail) => {
    results.push(ok);
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` ${JSON.stringify(detail)?.slice(0, 1500)}`}`);
};
// Poll observable UI state rather than assuming navigation or a terminal event has settled.
const eventually = async (name, read, matches, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    let value;
    do {
        value = await read();
        if (matches(value)) {
            check(name, true);
            return;
        }
        await delay(100);
    } while (Date.now() < deadline);
    check(name, false, value);
};

// The first stream lasts 20 seconds so sending and switching/expanding/collapsing happen mid-job.
const stream = (prefix) => ({ chunks: Array.from({ length: 40 }, (_, i) => `${prefix}${i} `), delayMs: 500 });
let mode = stream("away-part");
const provider = http.createServer(async (req, res) => {
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = JSON.parse(Buffer.concat(parts).toString() || "{}");
    const { chunks, delayMs } = mode;
    if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: chunks.join("") } }] }));
        return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const chunk of chunks) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
        await delay(delayMs);
    }
    res.end("data: [DONE]\n\n");
});

let stack;
let browser;
let context;
let blocked = [];
const pageErrors = [];
try {
    const providerHost = option("--provider-host");
    await new Promise((resolve) => provider.listen(0, providerHost ? "0.0.0.0" : "127.0.0.1", resolve));
    const providerUrl = `http://${providerHost ?? "127.0.0.1"}:${provider.address().port}/v1/chat/completions`;
    stack = option("--base") ? null : await startStack({ serverPort: 6231, vitePort: 5331 });
    const base = option("--base") ?? stack.baseURL;
    const password = option("--password") ?? "playwright";
    console.log(`mode: ${stack ? "dev" : "production"} at ${base}`);
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
    blocked = await isolateContext(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
    let auth = null;
    let epoch = null;
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
    });
    page.on("response", (response) => {
        const value = response.headers()["x-resource-epoch"];
        if (value) epoch = value;
    });
    const open = async () => {
        auth = null;
        if (stack) {
            await openApp(page, base, password);
        } else {
            // openApp reads Vite modules; the built app is opened through its password UI instead.
            await page.goto(base);
            await page.waitForFunction(() => document.querySelector("input") || document.querySelector(".rs-sidebar"));
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                const input = page.locator("input:visible").first();
                const ok = page.getByRole("button", { name: "OK", exact: true });
                if ((await ok.count()) > 0 && (await input.count()) > 0) {
                    await input.fill(password);
                    await ok.first().click();
                }
                if (auth && (await ok.count()) === 0 && (await page.locator(".rs-sidebar").count()) > 0) break;
                await delay(500);
            }
        }
        await page.locator("[data-risu-home-section='pinned-chats']").waitFor({ timeout: 30000 });
        // Let the boot's default record saves settle before reading revisions for the fixture batch.
        await delay(1500);
        if (!auth) throw new Error("The app did not authenticate");
    };
    const api = async (route, init = {}) => {
        const response = await fetch(base + route, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    await open();
    const ui = (await api("/api/resources/ui/main")).body;
    epoch = ui.epoch ?? epoch;
    const order = (await api("/api/resources/characterOrder/main")).body;
    const presets = (await api("/api/resources/presets/main")).body;
    const modelPresets = (await api("/api/resources/modelPresets/main")).body;
    const modelProfiles = (await api("/api/resources/modelProfiles/main")).body;
    const providers = (await api("/api/resources/providers/main")).body;
    const personas = (await api("/api/resources/personas/main")).body;
    const preset = {
        ...presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: providerUrl,
        customProxyRequestModel: "mock",
        customTokenizer: "tik",
        maxContext: 4000,
        maxResponse: 100,
        mainPrompt: "Main prompt for {{char}}.",
    };
    const character = (chaId, name) => ({
        name,
        firstMessage: `Greetings from ${name}.`,
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
    });
    const chaA = randomUUID();
    const chaB = randomUUID();
    const chatA = randomUUID();
    const chatB = randomUUID();
    const folderId = randomUUID();
    const chatOp = (characterId, chatId, pinned) => ({
        characterId,
        chatId,
        baseRevision: null,
        ops: [
            {
                op: "create",
                chat: {
                    id: chatId,
                    name: `Chat of ${characterId === chaA ? "A" : "B"}`,
                    fmIndex: -1,
                    message: [],
                    ...(pinned ? { pinned: true } : {}),
                    ...chatBindingFixture(modelPresets, presets, personas),
                },
            },
        ],
    });
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                ...modelFixtureOps(preset, modelPresets, modelProfiles),
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: { ...ui.data, language: "en", didFirstSetup: true, useSayNothing: false },
                },
                {
                    kind: "presets",
                    id: "main",
                    baseRevision: presets.revision,
                    data: [promptFixture(preset), ...presets.data.slice(1)],
                },
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: true },
                },
                { kind: "characters", id: chaA, baseRevision: null, data: character(chaA, "Alpha") },
                { kind: "characters", id: chaB, baseRevision: null, data: character(chaB, "Beta") },
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [
                        ...(Array.isArray(order.data) ? order.data : []),
                        { type: "folder", id: folderId, name: "Status Folder", color: "blue", data: [chaA] },
                        chaB,
                    ],
                },
            ],
            chats: [chatOp(chaA, chatA, true), chatOp(chaB, chatB, false)],
        }),
    });
    check("seed: two bound chats, Alpha pinned inside a folder, Beta outside", seeded.status === 200, seeded);
    if (seeded.status !== 200) throw new Error("Fixture batch failed");
    await open();

    const pinRow = page.locator(`[data-risu-pinned-chat="${chatA}"]`);
    const charRow = (chaId) => page.locator(`div[role="button"][tabindex="0"]:has([data-char-id="${chaId}"])`).first();
    const folderRow = page
        .locator('div[role="listitem"]:has(svg.lucide-folder, svg.lucide-folder-open) > div[role="button"]')
        .first();
    const statusOf = async (locator) =>
        (await locator.count()) ? await locator.getAttribute("data-risu-chat-status") : "(absent)";
    const hasStatus = (name, locator, status, timeout) =>
        eventually(
            name,
            () => statusOf(locator),
            (value) => value === status,
            timeout,
        );
    await pinRow.waitFor({ state: "visible", timeout: 15000 });
    check("rest: pinned row present", (await pinRow.count()) === 1);
    check("rest: no badge or status anywhere", (await page.locator("[data-risu-chat-status]").count()) === 0);

    await pinRow.click();
    await page.getByText("Greetings from Alpha.").first().waitFor({ timeout: 15000 });
    const input = page.locator("textarea.input-text").first();
    await input.fill("Hello Alpha, reply while I look elsewhere");
    await input.press("Enter");
    await page.getByText("away-part0").first().waitFor({ timeout: 30000 });
    await charRow(chaB).click();
    await page.getByRole("button", { name: /Open most recent chat/ }).waitFor({ timeout: 15000 });
    await hasStatus("B selected: pin A generating", pinRow, "generating");
    await hasStatus("B selected: collapsed folder generating", folderRow, "generating");
    await hasStatus("B selected: character B has no status", charRow(chaB), null);
    check(
        "generating: pin accessible name carries status",
        /Generating a reply/.test(await pinRow.getAttribute("aria-label")),
    );
    check(
        "generating: no badge has a tabindex",
        (await page.locator("[data-risu-chat-status][role=status][tabindex]").count()) === 0,
    );

    // Folders start collapsed. Open before collapsing so both transitions exercise the avatar.
    await folderRow.locator("span[role=button]").click();
    await hasStatus("open folder: member A generating", charRow(chaA), "generating");
    await hasStatus("open folder: folder row has no status", folderRow, null);
    await folderRow.locator("span[role=button]").click();
    await hasStatus("collapsed again: folder generating", folderRow, "generating");

    // Alpha's reply isn't rendered while Beta is selected; wait for the terminal badge transition.
    await hasStatus("completed away: pin A unseen", pinRow, "unseen", 60000);
    await hasStatus("completed away: collapsed folder unseen", folderRow, "unseen");

    // Home is reached through the sidebar button, keeping the tab's in-memory unseen marks.
    const homeButton = page.locator(".rs-sidebar button:has(svg.lucide-house)").first();
    if ((await homeButton.count()) === 0) {
        await page.locator(".rs-sidebar button:has(svg.lucide-list)").first().click();
    }
    await homeButton.click();
    const homeCard = page.locator(`[data-risu-home-pinned-chat="${chatA}"]`);
    await homeCard.waitFor({ state: "visible", timeout: 15000 });
    await hasStatus("home: pinned card carries matching unseen status", homeCard, "unseen");
    const homeLabel = await homeCard.getAttribute("aria-label");
    check(
        "home: accessible name and title carry unseen status",
        /New reply/.test(homeLabel ?? "") && (await homeCard.getAttribute("title")) === homeLabel,
        homeLabel,
    );
    check(
        "home: card renders the shared unseen badge",
        (await homeCard.locator('[data-risu-chat-status="unseen"][role=status]').count()) === 1,
    );

    await charRow(chaB).click();
    await pinRow.focus();
    await page.keyboard.press("Enter");
    await page.getByText("away-part39").first().waitFor({ timeout: 30000 });
    check("Enter on pin: completed reply is visible", await page.getByText("away-part39").first().isVisible());
    await eventually(
        "Enter on pin: every badge and row status clears",
        () => page.locator("[data-risu-chat-status]").count(),
        (count) => count === 0,
    );

    // Generating on the open chat's pin is allowed. Only check unseen after this send completes.
    mode = stream("open-part");
    await input.fill("Reply while I keep this chat open");
    await input.press("Enter");
    await page.getByText("open-part39").first().waitFor({ timeout: 60000 });
    await hasStatus("completed in open chat: generating status clears", pinRow, null, 30000);
    check(
        "completed in open chat: reply visible and no unseen badge anywhere",
        (await page.getByText("open-part39").first().isVisible()) &&
            (await page.locator('[data-risu-chat-status="unseen"]').count()) === 0,
    );
} catch (error) {
    check("browser flow completed", false, String(error));
} finally {
    check("no page errors", pageErrors.length === 0, pageErrors);
    const egress = unexpectedEgress(blocked, stack ? await stack.deniedEgress() : []);
    check("no unexpected intercepted egress", egress.length === 0, egress);
    await context?.close();
    await browser?.close();
    await stack?.stop();
    provider.closeAllConnections();
    if (provider.listening) await new Promise((resolve) => provider.close(resolve));
    console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
    if (results.some((ok) => !ok)) process.exitCode = 1;
}
