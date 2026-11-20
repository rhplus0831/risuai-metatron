// Browser probe for the two transcript scroll symptoms recorded in ../fork-chat-scroll.md:
//   1. scroll input while a chat is still opening, or while a reply streams, leaves the reader in
//      the middle of a message;
//   2. a chat write shaped like a plugin's (`applyChatResult`, what `setChatToIndex` ends in) moves
//      the reader, in the worst case to the very bottom.
// It asserts nothing: every scenario prints one JSON line with where the reader was at each step
// (`where`: the scroll offset, the newest row's top against the view's top, and the first marked
// paragraph at the view's top), so the report's tables can be re-derived. Each scenario opens its
// own character, so none inherits another's state. The `control/` scenarios repeat a write with
// the scroller's `overflow-anchor` set to `none`.
//
// Usage (from the repository root, dev stack only; the whole set takes about six minutes):
//   node docs/reports/surveys/fork-chat-scroll/probeChatScroll.mjs [name-substring[,name-substring...]]
// `DEBUG=1` prints the stack's output. Do not edit a file of the checkout while it runs, and run it
// beside no other dev stack of the checkout.
import { randomUUID } from "node:crypto";
import http from "node:http";
import { chromium } from "playwright-core";
import {
    chromePath,
    isolateContext,
    openApp,
    openCharacterChat,
    startStack,
} from "../../../../util/playwright/stack.mjs";
import { chatBindingFixture, modelFixtureOps, promptFixture } from "../../../../util/playwright/modelProfiles.mjs";

const only = process.argv[2] ?? "";
const pad = (n) => String(n).padStart(2, "0");
const filler =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et " +
    "dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.";
// A 400x600 image the server answers late, so a row grows after it was shown.
let imageDelay = 3000;
const images = http.createServer((req, res) => {
    setTimeout(() => {
        res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
        res.end(
            '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600"><rect width="400" height="600" fill="#888"/></svg>',
        );
    }, imageDelay);
});
await new Promise((resolve) => images.listen(0, "127.0.0.1", () => resolve()));
const imageBase = `http://127.0.0.1:${images.address().port}`;

// A provider that streams a reply of 30 marked paragraphs (`[s00]`...) over about six seconds.
const provider = http.createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 30; i++) {
        if (res.destroyed) return;
        const text = `[s${pad(i)}] **Bold** ${filler}\n\n`;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "[END]" } }] })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", () => resolve()));
const providerBase = `http://127.0.0.1:${provider.address().port}`;

/**
 * A message of `paragraphs` marked paragraphs: `[m07-p03]` names message 7, paragraph 3. With
 * `imageTag`, a late image follows paragraphs 1 and 9; the tag keeps a scenario's images out of the
 * page's memory cache of an earlier one.
 */
const body = (m, paragraphs = 20, imageTag = null) =>
    Array.from(
        { length: paragraphs },
        (_, p) =>
            `[m${pad(m)}-p${pad(p)}] **Bold** ${filler}` +
            (imageTag && (p === 1 || p === 9) ? `\n\n<img src="${imageBase}/${imageTag}-m${m}p${p}.svg">` : ""),
    ).join("\n\n");
const longChat = (imageTag = null) =>
    Array.from({ length: 14 }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "char",
        data: body(i + 1, 20, imageTag),
        chatId: `m${pad(i + 1)}`,
        saying: "",
        time: i + 1,
    }));
const shortChat = () => [
    { role: "user", data: "[m01-p00] Hello.", chatId: "m01", saying: "", time: 1 },
    { role: "char", data: body(2, 30), chatId: "m02", saying: "", time: 2 },
];

/**
 * A chat result the way a plugin hands one back: `kind` says what it changed.
 * - `tail-keep`: the newest message's text, its id kept (one word, so the height stays).
 * - `tail-grow`: the newest message gets ten more paragraphs, its id kept.
 * - `tail-newid`: the newest message's text, its id dropped (a plugin that rebuilds the object).
 * - `all-newid`: every message rebuilt without an id.
 * - `older-keep`: the oldest message's text, its id kept.
 */
const edit = (page, chaId, kind) =>
    page.evaluate(
        async ({ chaId, kind }) => {
            const store = await import("/src/ts/storage/chatStore.svelte.ts");
            const baseline = store.captureChatBaseline({ chaId, chatId: "c" });
            const result = JSON.parse(JSON.stringify(baseline.chat));
            const tail = result.message.at(-1);
            if (kind === "tail-keep") tail.data = tail.data.replace("Bold", "BOLD");
            if (kind === "tail-grow")
                tail.data += Array.from({ length: 10 }, (_, p) => `\n\n[added-p${p}] ${tail.data.slice(15, 200)}`).join(
                    "",
                );
            if (kind === "tail-newid") {
                delete tail.chatId;
                tail.data = tail.data.replace("Bold", "BOLD");
            }
            if (kind === "all-newid")
                result.message = result.message.map(({ chatId, ...message }) => ({
                    ...message,
                    data: message.data.replace("Bold", "BOLD"),
                }));
            if (kind === "older-keep") result.message[0].data = result.message[0].data.replace("Bold", "BOLD");
            store.applyChatResult(baseline, result);
        },
        { chaId, kind },
    );

/**
 * Where the reader is: the scroll offset, the newest row, and the first paragraph at the view's top
 * (`reading`; hidden paragraphs are not skipped, so read it only once the opening's mask is gone).
 */
const where = (page) =>
    page.evaluate(() => {
        const first = document.querySelector(".chat-message-container");
        if (!first) return null;
        const list = first.parentElement;
        const scroller = list.parentElement;
        const view = scroller.getBoundingClientRect();
        const rows = [...list.children].filter((element) => element.classList.contains("chat-message-container"));
        const newest = rows[0].getBoundingClientRect();
        let mark = null;
        for (const paragraph of list.querySelectorAll("p")) {
            const rect = paragraph.getBoundingClientRect();
            if (rect.height <= 0 || rect.bottom <= view.top + 1) continue;
            if (mark === null || rect.top < mark.y)
                mark = { y: rect.top, id: /\[([a-z0-9-]+)\]/.exec(paragraph.textContent)?.[1] ?? "?" };
        }
        return {
            scrollTop: Math.round(scroller.scrollTop * 10) / 10,
            fromTop: Math.round(scroller.scrollHeight - scroller.clientHeight + scroller.scrollTop),
            view: Math.round(view.height),
            newestId: rows[0].querySelector(".risu-chat")?.dataset.chatId ?? null,
            newestTop: Math.round(newest.top - view.top),
            newestHeight: Math.round(newest.height),
            reading: mark ? `${mark.id}@${Math.round(mark.y - view.top)}` : null,
            newestBottom: Math.round(newest.bottom - view.bottom),
            rows: rows.length,
            images: `${[...list.querySelectorAll("img")].filter((image) => image.src.includes(".svg") && image.complete && image.naturalHeight > 0).length}/${[...list.querySelectorAll("img")].filter((image) => image.src.includes(".svg")).length}`,
            held: rows.filter((element) => element.classList.contains("chat-row-held")).length,
            pending: rows.filter((element) => element.classList.contains("chat-row-pending")).length,
        };
    });

/** Records `scrollTop`, `scrollHeight` and the newest row's height on every frame that changes one, for `ms`. */
const trace = (page, ms) =>
    page.evaluate(
        (ms) =>
            new Promise((resolve) => {
                const seen = [];
                const start = performance.now();
                const frame = () => {
                    const first = document.querySelector(".chat-message-container");
                    const scroller = first?.parentElement.parentElement;
                    if (scroller) {
                        const entry = {
                            t: Math.round(performance.now() - start),
                            scrollTop: Math.round(scroller.scrollTop * 10) / 10,
                            scrollHeight: scroller.scrollHeight,
                            newestHeight: Math.round(first.getBoundingClientRect().height),
                        };
                        const last = seen.at(-1);
                        if (
                            last?.scrollTop !== entry.scrollTop ||
                            last.scrollHeight !== entry.scrollHeight ||
                            last.newestHeight !== entry.newestHeight
                        )
                            seen.push(entry);
                    }
                    if (performance.now() - start < ms) requestAnimationFrame(frame);
                    else resolve(seen);
                };
                requestAnimationFrame(frame);
            }),
        ms,
    );

const stack = await startStack({
    serverPort: 6331,
    vitePort: 5431,
    log: process.env.DEBUG ? (text) => process.stderr.write(text) : undefined,
});
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
let failed = false;
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await isolateContext(context);
    let auth = null;
    let epoch = null;
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`PAGE ERROR ${String(error).slice(0, 300)}`));
    page.on("request", (request) => {
        const headers = request.headers();
        if (headers["risu-auth"]) auth = headers["risu-auth"];
        if (headers["x-resource-epoch"]) epoch = headers["x-resource-epoch"];
    });
    const api = async (path, init = {}) => {
        const response = await fetch(stack.baseURL + path, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        return { status: response.status, body: await response.json().catch(() => null) };
    };
    const single = async (kind) => (await api(`/api/resources/${kind}/main`)).body;
    const cdp = await context.newCDPSession(page);

    await openApp(page, stack.baseURL);
    await page.waitForTimeout(1500);

    // name, messages, CPU throttle, and what the reader does.
    const scenarios = [
        // Symptom 1: input while the chat opens.
        { name: "open/no-input", cpu: 1, run: "open" },
        { name: "open/wheel-after-settle", cpu: 1, run: "open", after: -120 },
        { name: "open/wheel-during-reveal", cpu: 1, run: "open", during: -120 },
        { name: "open/wheel-during-reveal/cpu4", cpu: 4, run: "open", during: -120 },
        { name: "open/wheel-after-settle/cpu4", cpu: 4, run: "open", after: -120 },
        { name: "open/tiny-wheel-during-reveal/cpu4", cpu: 4, run: "open", during: -1 },
        { name: "open/wheel-down-during-reveal/cpu4", cpu: 4, run: "open", during: 120 },
        // Symptom 2: a plugin-shaped chat write.
        { name: "edit/anchored/tail-keep", cpu: 1, run: "edit", kind: "tail-keep" },
        { name: "edit/anchored/tail-newid", cpu: 1, run: "edit", kind: "tail-newid" },
        { name: "edit/anchored/all-newid", cpu: 1, run: "edit", kind: "all-newid" },
        { name: "edit/in-newest/tail-keep", cpu: 1, run: "edit", kind: "tail-keep", after: -500 },
        { name: "edit/in-newest/tail-grow", cpu: 1, run: "edit", kind: "tail-grow", after: -500 },
        { name: "edit/in-newest/tail-newid", cpu: 1, run: "edit", kind: "tail-newid", after: -500 },
        { name: "edit/in-older/tail-keep", cpu: 1, run: "edit", kind: "tail-keep", after: -5000 },
        { name: "edit/in-older/tail-grow", cpu: 1, run: "edit", kind: "tail-grow", after: -5000 },
        { name: "edit/in-older/older-keep", cpu: 1, run: "edit", kind: "older-keep", after: -5000 },
        { name: "edit/in-older/all-newid", cpu: 1, run: "edit", kind: "all-newid", after: -5000 },
        {
            name: "edit/short-chat/in-newest/tail-keep",
            cpu: 1,
            run: "edit",
            kind: "tail-keep",
            after: -500,
            short: true,
        },
        // Controls: the same writes with the browser's own scroll anchoring off.
        {
            name: "control/in-newest/tail-keep/no-native-anchoring",
            cpu: 1,
            run: "edit",
            kind: "tail-keep",
            after: -500,
            noNative: true,
        },
        {
            name: "control/in-older/tail-keep/no-native-anchoring",
            cpu: 1,
            run: "edit",
            kind: "tail-keep",
            after: -5000,
            noNative: true,
        },
        // Symptom 1 with rows that grow late: two images per message, answered after 3 s.
        { name: "images/no-input", cpu: 1, run: "open", withImages: true },
        { name: "images/wheel-after-settle", cpu: 1, run: "open", withImages: true, after: -120 },
        {
            name: "images/wheel-shown-before-images",
            cpu: 1,
            run: "open",
            withImages: true,
            during: -120,
            wheelAt: 1800,
        },
        {
            name: "images/tiny-wheel-shown-before-images",
            cpu: 1,
            run: "open",
            withImages: true,
            during: -1,
            wheelAt: 1800,
        },
        { name: "images/wheel-while-masked", cpu: 1, run: "open", withImages: true, during: -120, wheelAt: 400 },
        { name: "images/tiny-wheel-while-masked", cpu: 1, run: "open", withImages: true, during: -1, wheelAt: 400 },
        // Symptom 1 at an exact moment: a wheel event dispatched by the page when the opening's mask
        // first appears (`synthetic`: it reaches the listeners and scrolls nothing, as a real wheel or
        // a touch jitter does while the content is still shorter than the view).
        { name: "open/synthetic-wheel-at-mask", cpu: 1, run: "open", synthetic: 0 },
        { name: "open/synthetic-wheel-at-mask+50ms", cpu: 1, run: "open", synthetic: 50 },
        { name: "images/synthetic-wheel-at-mask", cpu: 1, run: "open", withImages: true, synthetic: 0 },
        // Symptom 1 while a reply streams: input about 2.5 s into a 6 s stream.
        { name: "stream/no-input", cpu: 1, run: "stream" },
        { name: "stream/wheel-up-100", cpu: 1, run: "stream", during: -100 },
        { name: "stream/wheel-up-3", cpu: 1, run: "stream", during: -3 },
        { name: "stream/wheel-down-100", cpu: 1, run: "stream", during: 100 },
        { name: "stream/synthetic-wheel", cpu: 1, run: "stream", synthetic: 0 },
        {
            name: "control/stream/wheel-up-100/no-native-anchoring",
            cpu: 1,
            run: "stream",
            during: -100,
            noNative: true,
        },
        // Symptom 1 with real input: 1 px wheel notches every few milliseconds while the chat opens.
        { name: "open/real-wheel-burst", cpu: 1, run: "open", burst: true },
        { name: "open/real-wheel-burst/cpu4", cpu: 4, run: "open", burst: true },
    ].filter((scenario) => only.split(",").some((part) => scenario.name.includes(part)));

    const ui = await single("ui");
    epoch = ui.epoch ?? epoch;
    const order = await single("characterOrder");
    const presets = await single("presets");
    const modelPresets = await single("modelPresets");
    const modelProfiles = await single("modelProfiles");
    const personas = await single("personas");
    const providers = await single("providers");
    const preset = {
        ...presets.data[0],
        aiModel: "reverse_proxy",
        subModel: "reverse_proxy",
        forceReplaceUrl: `${providerBase}/v1/chat/completions`,
        customProxyRequestModel: "mock",
        maxContext: 4000,
        maxResponse: 100,
    };
    for (const scenario of scenarios) scenario.chaId = randomUUID();
    const seeded = await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                ...modelFixtureOps({ ...preset, customTokenizer: "tik" }, modelPresets, modelProfiles),
                { kind: "presets", id: "main", baseRevision: presets.revision, data: [promptFixture(preset)] },
                {
                    kind: "providers",
                    id: "main",
                    baseRevision: providers.revision,
                    data: { ...providers.data, useStreaming: true },
                },
                { kind: "ui", id: "main", baseRevision: ui.revision, data: { ...ui.data, didFirstSetup: true } },
                ...scenarios.map(({ chaId, name }) => ({
                    kind: "characters",
                    id: chaId,
                    baseRevision: null,
                    data: {
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
                    },
                })),
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...order.data, ...scenarios.map(({ chaId }) => chaId)],
                },
            ],
            chats: scenarios.map(({ chaId, short, withImages }) => ({
                characterId: chaId,
                chatId: "c",
                baseRevision: null,
                ops: [
                    {
                        op: "create",
                        chat: {
                            id: "c",
                            name: "Scroll",
                            note: "",
                            localLore: [],
                            ...chatBindingFixture(modelPresets, presets, personas),
                            message: short ? shortChat() : longChat(withImages ? chaId : null),
                        },
                    },
                ],
            })),
        }),
    });
    if (seeded.status !== 200) throw new Error(`seed failed: ${JSON.stringify(seeded).slice(0, 500)}`);

    for (const scenario of scenarios) {
        const { name, chaId, cpu, during, after, kind, wheelAt, withImages, noNative, synthetic, run, burst } =
            scenario;
        await page.locator(`[data-char-id="${chaId}"]`).first().waitFor({ timeout: 15000 });
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
        await page.mouse.move(700, 400);
        if (synthetic !== undefined && run === "open")
            await page.evaluate((delay) => {
                window.__syntheticWheel = null;
                const observer = new MutationObserver(() => {
                    const pending = document.querySelector(".chat-row-pending");
                    if (!pending) return;
                    observer.disconnect();
                    setTimeout(() => {
                        const first = document.querySelector(".chat-message-container");
                        const scroller = first.parentElement.parentElement;
                        window.__syntheticWheel = {
                            scrollTop: scroller.scrollTop,
                            newestHeight: Math.round(first.getBoundingClientRect().height),
                            pending: document.querySelectorAll(".chat-row-pending").length,
                        };
                        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
                    }, delay);
                });
                observer.observe(document.body, {
                    subtree: true,
                    attributes: true,
                    attributeFilter: ["class"],
                    childList: true,
                });
            }, synthetic);
        const out = { name };
        if (burst) {
            await page.locator(`[data-char-id="${chaId}"]`).first().click();
            const open = page.getByRole("button", { name: /Open most recent chat/ });
            await open.waitFor();
            await page.evaluate(() => {
                window.__wheels = [];
                // One listener for the page's lifetime: a second scenario must not count twice.
                if (window.__wheelsListening) return;
                window.__wheelsListening = true;
                document.addEventListener(
                    "wheel",
                    () => {
                        const first = document.querySelector(".chat-message-container");
                        if (!first) return;
                        window.__wheels.push({
                            scrollTop: first.parentElement.parentElement.scrollTop,
                            newestHeight: Math.round(first.getBoundingClientRect().height),
                            pending: document.querySelectorAll(".chat-row-pending").length,
                        });
                    },
                    { capture: true, passive: true },
                );
            });
            const wheels = (async () => {
                for (let i = 0; i < 150; i++) {
                    await page.mouse.wheel(0, -1);
                    await new Promise((resolve) => setTimeout(resolve, 4));
                }
            })();
            await open.click();
            await page.mouse.move(700, 400);
            await wheels;
            // The wheel events that reached the transcript before its newest row had rendered.
            out.atInput = await page.evaluate(() => ({
                wheels: window.__wheels.length,
                early: window.__wheels.filter((entry) => entry.newestHeight < 400).length,
                first: window.__wheels[0] ?? null,
            }));
        } else await openCharacterChat(page, chaId);
        if (during !== undefined && run === "open") {
            // The opening hides its rows (`chat-row-pending`) until they have rendered.
            await page.waitForFunction(() => document.querySelector(".chat-row-pending"), null, { polling: "raf" });
            if (wheelAt) await page.waitForTimeout(wheelAt);
            out.atInput = await where(page);
            await page.mouse.wheel(0, during);
        }
        await page.locator(".chat-message-container").first().waitFor({ timeout: 15000 });
        await page.waitForTimeout(withImages ? imageDelay + 4000 : 4500 * Math.min(cpu, 2));
        out.opened = await where(page);
        if (synthetic !== undefined && run === "open") out.atInput = await page.evaluate(() => window.__syntheticWheel);
        if (run === "stream") {
            if (noNative)
                await page.evaluate(() => {
                    document.querySelector(".chat-message-container").parentElement.parentElement.style.overflowAnchor =
                        "none";
                });
            const input = page.locator("textarea.input-text").first();
            await input.fill("Go on.");
            await input.press("Enter");
            await page.getByText("[s10]").first().waitFor({ timeout: 30000 });
            out.atInput = await where(page);
            if (during !== undefined) await page.mouse.wheel(0, during);
            if (synthetic !== undefined)
                await page.evaluate(() => {
                    const scroller = document.querySelector(".chat-message-container").parentElement.parentElement;
                    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true }));
                });
            await page.waitForTimeout(300);
            out.afterInput = await where(page);
            await page.getByText("[s27]").first().waitFor({ timeout: 30000 });
            out.nearEnd = await where(page);
            out.frames = await trace(page, 4000);
            await page.getByText("[END]").first().waitFor({ timeout: 30000 });
            await page.waitForTimeout(1500);
            out.streamed = await where(page);
        }
        if (after !== undefined) {
            // Several notches for a long way: one large delta is clamped to the view.
            for (let left = after; left !== 0;) {
                const step = Math.max(-400, Math.min(400, left));
                await page.mouse.wheel(0, step);
                left -= step;
                await page.waitForTimeout(120);
            }
            await page.waitForTimeout(1500);
            out.scrolled = await where(page);
        }
        if (noNative)
            await page.evaluate(() => {
                document.querySelector(".chat-message-container").parentElement.parentElement.style.overflowAnchor =
                    "none";
            });
        if (kind) {
            const frames = trace(page, 2500);
            await edit(page, chaId, kind);
            out.frames = await frames;
            await page.waitForTimeout(500);
            out.edited = await where(page);
        }
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
        console.log(JSON.stringify(out));
    }
} catch (error) {
    console.error(error);
    failed = true;
} finally {
    await browser.close();
    await stack.stop();
    images.close();
    provider.close();
}
process.exit(failed ? 1 : 0);
