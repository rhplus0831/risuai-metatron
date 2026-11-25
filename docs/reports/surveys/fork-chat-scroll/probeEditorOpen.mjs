// From the repository root: util/playwright/offline.sh pnpm exec node docs/reports/surveys/fork-chat-scroll/probeEditorOpen.mjs
// One JSON object per step. Chrome's reversed transcript has scrollTop === 0 at the bottom.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import {
    chromePath,
    isolateContext,
    openApp,
    openCharacterChat,
    startStack,
} from "../../../../util/playwright/stack.mjs";
import { chatBindingFixture } from "../../../../util/playwright/modelProfiles.mjs";

const scenarios = [
    { name: "newest", target: 14, up: 300 },
    { name: "anchor-none", target: 14, up: 300 },
    { name: "older", target: 12, up: 300 },
    { name: "bottom", target: 14, up: 0 },
    { name: "short", target: 14, up: 40 },
    { name: "newest-settled-only", target: 14, up: 300 },
    { name: "save", target: 14, up: 300 },
    { name: "save-clamped", target: 14, up: 300 },
    { name: "reader-scrolled", target: 14, up: 300 },
    { name: "two-editors-first-close", target: 13, up: 300 },
    { name: "two-editors-safe-save", target: 14, up: 300 },
    { name: "two-editors-clipped-save", target: 14, up: 300 },
].map((scenario) => ({ ...scenario, chaId: randomUUID() }));

const id = (n) => "m" + String(n).padStart(2, "0");
const filler =
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et " +
    "dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip.";
const messages = (short) =>
    Array.from({ length: 14 }, (_, i) => ({
        chatId: id(i + 1),
        saying: "",
        time: i + 1,
        role: i % 2 === 0 ? "user" : "char",
        data: Array.from(
            { length: short && i === 13 ? 1 : 20 },
            (_, p) => `[${id(i + 1)}-p${String(p).padStart(2, "0")}] **Bold** ${filler}`,
        ).join("\n\n"),
    }));

async function seed(page, stack) {
    let auth, epoch;
    page.on("request", (request) => {
        auth = request.headers()["risu-auth"] ?? auth;
        epoch = request.headers()["x-resource-epoch"] ?? epoch;
    });
    const api = async (path, init) => {
        const response = await fetch(stack.baseURL + path, {
            ...init,
            headers: { "risu-auth": auth, "x-resource-epoch": epoch, "content-type": "application/json" },
        });
        const body = await response.json();
        if (!response.ok) throw Error(`${path}: ${response.status} ${JSON.stringify(body)}`);
        return body;
    };
    await openApp(page, stack.baseURL);
    const [ui, order, models, prompts, personas] = await Promise.all(
        ["ui", "characterOrder", "modelPresets", "presets", "personas"].map((kind) =>
            api(`/api/resources/${kind}/main`),
        ),
    );
    epoch = ui.epoch ?? epoch;
    await api("/api/resources/batch", {
        method: "POST",
        body: JSON.stringify({
            ops: [
                {
                    kind: "ui",
                    id: "main",
                    baseRevision: ui.revision,
                    data: {
                        ...ui.data,
                        didFirstSetup: true,
                        clickToEdit: true,
                        disableAutoPopupMessageEditor: true,
                    },
                },
                ...scenarios.map(({ chaId, name }) => ({
                    kind: "characters",
                    id: chaId,
                    baseRevision: null,
                    data: { chaId, name, type: "character", firstMessage: "Greetings.", viewScreen: "none" },
                })),
                {
                    kind: "characterOrder",
                    id: "main",
                    baseRevision: order.revision,
                    data: [...order.data, ...scenarios.map((s) => s.chaId)],
                },
            ],
            chats: scenarios.map(({ chaId, name }) => ({
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
                            ...chatBindingFixture(models, prompts, personas),
                            message: messages(name === "short"),
                        },
                    },
                ],
            })),
        }),
    });
}

// Runs in the page after the opening mask has cleared. Keep node references to distinguish swapping
// the body from remounting Chat. Use the survey's paragraph and viewport coordinates.
function installMeasurements(targetId) {
    const card = document.querySelector(`.risu-chat[data-chat-id="${targetId}"]`);
    const row = card.closest(".chat-message-container");
    const list = row.parentElement;
    const scroller = list.parentElement;
    const newest = list.querySelector(".chat-message-container");
    const round = (n) => Math.round(n * 10) / 10;
    const height = (el) => (el ? round(el.getBoundingClientRect().height) : null);
    const area = () => row.querySelector(".message-edit-area");
    const where = () => {
        const view = scroller.getBoundingClientRect();
        const style = getComputedStyle(row);
        const editor = area();
        let mark = null;
        for (const p of list.querySelectorAll(".chattext p")) {
            // Off-screen contained rows do not need to be laid out to find a visible marker.
            const r = p.closest(".chat-message-container").getBoundingClientRect();
            if (r.bottom <= view.top || r.top >= view.bottom) continue;
            const rect = p.getBoundingClientRect();
            const id = /\[(m\d+-p\d+)\]/.exec(p.textContent)?.[1];
            if (!id || rect.height <= 0 || rect.bottom <= view.top + 1 || rect.top >= view.bottom) continue;
            if (!mark || rect.top < mark.y) mark = { id, y: rect.top };
        }
        // Inside the field, use Chrome's native caret hit-test. A textarea has no rendered
        // <p> elements; the survey's DOM-only reading would skip to the next message.
        let sourceOffset = null;
        if (editor) {
            const rect = editor.getBoundingClientRect();
            const css = getComputedStyle(editor);
            const y = view.top + 1;
            if (rect.top < y && rect.bottom > y) {
                const x = rect.left + editor.clientLeft + parseFloat(css.paddingLeft) + 2;
                const caret = document.caretPositionFromPoint(x, y);
                if (caret?.offsetNode !== editor) throw Error("Top edge of the editor could not be hit-tested");
                sourceOffset = caret.offset;
                const start = editor.value.lastIndexOf("[m", sourceOffset);
                const id = /^\[(m\d+-p\d+)\]/.exec(editor.value.slice(start))?.[1];
                if (!id) throw Error("No source paragraph at the editor caret");
                mark = { id, y: null };
            } else if (editor.scrollTop === 0) {
                const top = rect.top + editor.clientTop + parseFloat(css.paddingTop);
                const id = /^\[([^\]]+)\]/.exec(editor.value)?.[1];
                if (id && top >= view.top && top < view.bottom && (!mark || top < mark.y)) mark = { id, y: top };
            }
        }
        return {
            scrollTop: round(scroller.scrollTop),
            view: round(view.height),
            scrollHeight: scroller.scrollHeight,
            reading: mark ? mark.id : null,
            readingY: mark?.y != null ? round(mark.y - view.top) : null,
            sourceOffset,
            newestTop: round(newest.getBoundingClientRect().top - view.top),
            rowTop: round(row.getBoundingClientRect().top - view.top),
            rowH: height(row),
            bodyH: height(row.querySelector(".chattext")),
            areaH: height(editor),
            areaTop: editor ? round(editor.getBoundingClientRect().top - view.top) : null,
            areaScrollTop: editor?.scrollTop ?? null,
            areaScrollHeight: editor?.scrollHeight ?? null,
            areaStyleHeight: editor?.style.height ?? null,
            sameCard: card.isConnected,
            minHeight: style.minHeight,
            far: row.classList.contains("far"),
            contentVisibility: style.contentVisibility,
            contain: style.contain,
            intrinsic: style.containIntrinsicBlockSize,
            anchor: getComputedStyle(scroller).overflowAnchor,
        };
    };
    function hitPoint(selector) {
        const el = row.querySelector(selector);
        const rect = el.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        const x = Math.round((rect.left + rect.right) / 2);
        const from = Math.ceil(Math.max(view.top, rect.top) + 2);
        const to = Math.floor(Math.min(view.bottom, rect.bottom) - 2);
        for (let y = Math.round((from + to) / 2); y >= from && y <= to; y--) {
            if (el.contains(document.elementFromPoint(x, y))) return { x, y };
        }
        for (let y = from; y <= to; y++) {
            if (el.contains(document.elementFromPoint(x, y))) return { x, y };
        }
        throw Error(`No visible point on ${selector} in ${targetId}: ${JSON.stringify(where())}`);
    }
    window.editorProbe = { row, newest, scroller, where, hitPoint, area };
}

async function frames(page, count = 3) {
    await page.evaluate(async (count) => {
        for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
    }, count);
}

async function cancelByLongPress(page, log) {
    // The user cancels by long-pressing the unchanged field. Advance only that gesture's timer.
    // Chrome's pointer, native layout, scroll anchoring and animation frames run on their normal clocks.
    const cancel = await page.evaluate(() => {
        const { area, hitPoint } = window.editorProbe;
        const point = hitPoint("textarea");
        area().addEventListener(
            "mousedown",
            () => {
                const original = window.setTimeout;
                window.setTimeout = function (fn, ms, ...args) {
                    if (ms === 500) {
                        window.finishLongPress = () => fn(...args);
                        return 0;
                    }
                    return original.call(window, fn, ms, ...args);
                };
                area().parentElement.addEventListener(
                    "mousedown",
                    () => {
                        window.setTimeout = original;
                    },
                    { once: true },
                );
            },
            { capture: true, once: true },
        );
        return point;
    });
    await page.mouse.move(cancel.x, cancel.y);
    await page.mouse.down();
    try {
        log("before-cancel", await page.evaluate(() => window.editorProbe.where()));
        await page.evaluate(() => {
            window.finishLongPress();
            delete window.finishLongPress;
        });
    } finally {
        await page.mouse.up();
    }
}

async function twoEditors(page, { name, target }, log, check, within) {
    const firstId = id(target);
    const secondId = id(target === 13 ? 14 : 13);
    const measure = async (rowId) => {
        await page.evaluate(installMeasurements, rowId);
        return page.evaluate(() => window.editorProbe.where());
    };
    const click = async (selector) => {
        const point = await page.evaluate((selector) => window.editorProbe.hitPoint(selector), selector);
        await page.mouse.click(point.x, point.y);
    };
    const waitForBody = async () => {
        await page.waitForFunction(() => {
            const { area, row } = window.editorProbe;
            return !area() && row.querySelector(".chattext p") && !row.style.minHeight;
        });
        await frames(page);
    };
    const fits = (state) => state.areaH > 0 && state.areaTop >= 0 && state.areaTop + state.areaH <= state.view;
    const beforeSecond = await measure(secondId);
    log("before-second-open", beforeSecond);
    await click(".chattext");
    await page.waitForFunction(() => window.editorProbe.area());
    await frames(page);
    const second = await measure(secondId);
    const first = await measure(firstId);
    log("first-with-both-open", first);
    log("second-with-both-open", second);
    check("both adjacent editors are mounted", await page.locator("textarea.message-edit-area").count(), 2);
    check("latest field fits in the transcript", fits(second), true);

    if (name === "two-editors-first-close") {
        await cancelByLongPress(page, log);
        await waitForBody();
        const remaining = await measure(secondId);
        log("second-after-first-close", remaining);
        within("closing the earlier editor leaves the latest field in place", remaining.areaTop, second.areaTop);
        await cancelByLongPress(page, log);
        await waitForBody();
        const closed = await measure(secondId);
        log("latest-closed", closed);
        within("closing the latest editor restores its row top", closed.rowTop, beforeSecond.rowTop);
        return;
    }

    await measure(secondId);
    const field = page.locator(`.risu-chat[data-chat-id="${secondId}"] textarea.message-edit-area`);
    const original = await field.inputValue();
    const clipped = name === "two-editors-clipped-save";
    const saved = clipped ? original + "\n\n" + original : original.split("\n\n").slice(0, -1).join("\n\n");
    await field.fill(saved);
    await click(".button-icon-edit");
    await waitForBody();
    const closed = await measure(secondId);
    const remaining = await measure(firstId);
    log("latest-saved", closed);
    log("first-after-latest-save", remaining);
    check("earlier field is wholly visible after save", fits(remaining), true);
    if (clipped) {
        const projectedTop = remaining.areaTop - (closed.rowTop - beforeSecond.rowTop);
        check("restoring the saved row would hide the earlier field", projectedTop > remaining.view, true);
        within("unsafe restoration leaves the transcript offset alone", remaining.scrollTop, second.scrollTop);
    } else {
        check(
            "the reachable restoration moves the transcript",
            Math.abs(remaining.scrollTop - second.scrollTop) > 2,
            true,
        );
        within("safe restoration returns the saved row to its pre-open top", closed.rowTop, beforeSecond.rowTop);
    }
    await cancelByLongPress(page, log);
    await waitForBody();
    const retired = await measure(firstId);
    log("earlier-editor-closed-last", retired);
    within("the earlier editor does not reclaim its old place", retired.scrollTop, remaining.scrollTop);
}

async function run(page, scenario) {
    const { name, chaId, target, up } = scenario;
    const log = (step, data) => console.log(JSON.stringify({ scenario: name, step, ...data }));
    const check = (expectation, actual, expected) => {
        log("assert", { expectation, result: actual === expected ? "PASS" : "FAIL", expected, received: actual });
        if (actual !== expected) process.exitCode = 1;
    };
    const within = (expectation, actual, expected, tolerance = 2) => {
        const pass = actual !== null && Math.abs(actual - expected) <= tolerance;
        log("assert", { expectation, result: pass ? "PASS" : "FAIL", expected, tolerance, received: actual });
        if (!pass) process.exitCode = 1;
    };
    await openCharacterChat(page, chaId);
    await page.waitForFunction(
        (expected) =>
            document.querySelectorAll('.risu-chat[data-chat-id^="m"] .chattext p').length === expected &&
            !document.querySelector(".chat-row-pending, .chat-row-held"),
        name === "short" ? 261 : 280,
    );
    await page.evaluate(installMeasurements, id(target));
    await frames(page);
    const origin = await page.evaluate(() => {
        const { scroller } = window.editorProbe;
        const r = scroller.getBoundingClientRect();
        const x = (r.left + r.right) / 2;
        const y = (r.top + r.bottom) / 2;
        if (!scroller.contains(document.elementFromPoint(x, y)))
            throw Error("Wheel would miss transcript: " + document.elementFromPoint(x, y).outerHTML.slice(0, 240));
        return { x, y };
    });
    await page.mouse.move(origin.x, origin.y);
    // Release the opening's start anchor with a real wheel, then position the fixture at
    // the bottom of the chosen message before applying the measured reader gesture.
    await page.evaluate(() => {
        window.wheelDelivered = new Promise((resolve) =>
            window.editorProbe.scroller.addEventListener("wheel", () => resolve(true), { once: true }),
        );
    });
    await page.mouse.wheel(0, 1);
    await page.evaluate(() => window.wheelDelivered);
    await frames(page);
    const start = await page.evaluate((name) => {
        const { scroller, row, newest } = window.editorProbe;
        // With native anchoring disabled the save cases isolate the transcript's proposed scroll.
        if (name === "anchor-none" || name === "two-editors-safe-save" || name === "two-editors-clipped-save")
            scroller.style.overflowAnchor = "none";
        // For the older row, give it the same bottom-relative starting geometry as the newest.
        scroller.scrollTop = row.getBoundingClientRect().bottom - newest.getBoundingClientRect().bottom;
        return scroller.scrollTop;
    }, name);
    if (up) {
        await page.mouse.wheel(0, -up);
        await page.waitForFunction((to) => Math.abs(window.editorProbe.scroller.scrollTop - to) <= 1, start - up);
    }
    await frames(page);
    const point = await page.evaluate(() => window.editorProbe.hitPoint(".chattext"));
    const before = await page.evaluate(() => window.editorProbe.where());
    log("before-click", before);
    const traceOpen = name !== "newest-settled-only";
    if (traceOpen)
        await page.evaluate(() => {
            const { where, area, row } = window.editorProbe;
            window.openTrace = new Promise((resolve) => {
                row.addEventListener(
                    "click",
                    () => {
                        const trace = [{ phase: "click-capture", ...where() }];
                        const observer = new MutationObserver(() => {
                            if (!area()) return;
                            observer.disconnect();
                            trace.push({ phase: "editor-in-DOM", ...where() });
                        });
                        observer.observe(row, { childList: true, subtree: true });
                        let frame = 0;
                        function sample() {
                            trace.push({ phase: `rAF-${++frame}`, ...where() });
                            if (frame < 3) requestAnimationFrame(sample);
                            else {
                                observer.disconnect();
                                resolve(trace);
                            }
                        }
                        requestAnimationFrame(sample);
                    },
                    { capture: true, once: true },
                );
            });
        });
    await page.mouse.click(point.x, point.y);
    await page
        .locator(`.risu-chat[data-chat-id="${id(target)}"] textarea.message-edit-area`)
        .waitFor({ state: "attached" });
    if (traceOpen) {
        for (const { phase, ...data } of await page.evaluate(() => window.openTrace)) log(phase, data);
    } else {
        // Independent replay: no observer and no geometry reads between the click and painted frames.
        await frames(page);
    }
    const open = await page.evaluate(() => window.editorProbe.where());
    log("open", open);
    if (name.startsWith("two-editors-")) {
        await twoEditors(page, scenario, log, check, within);
        return;
    }
    let expectedText = messages(name === "short")[target - 1].data;
    let scrolled;
    const saving = name === "save" || name === "save-clamped";
    if (saving) {
        if (name === "save-clamped") expectedText = expectedText.split("\n\n")[0];
        else expectedText += "\n\n" + Array.from({ length: 5 }, (_, i) => `[added-${i}] ${filler}`).join("\n\n");
        await page.locator("textarea.message-edit-area").fill(expectedText);
        const save = await page.evaluate(() => window.editorProbe.hitPoint(".button-icon-edit"));
        await page.mouse.click(save.x, save.y);
    } else {
        if (name === "reader-scrolled") {
            // A wheel above the field scrolls the transcript and leaves the field reachable.
            await page.mouse.move(origin.x, open.areaTop - 20);
            await page.mouse.wheel(0, -80);
            await page.waitForFunction((from) => window.editorProbe.scroller.scrollTop <= from - 79, open.scrollTop);
            await frames(page);
            scrolled = await page.evaluate(() => window.editorProbe.where());
            log("reader-scrolled", scrolled);
        }
        await cancelByLongPress(page, log);
    }
    await page.waitForFunction(() => !window.editorProbe.area() && window.editorProbe.row.querySelector(".chattext p"));
    await frames(page);
    const closed = await page.evaluate(() => window.editorProbe.where());
    log(saving ? "saved" : "canceled", closed);
    const stored = await page.evaluate(
        async ({ chaId, targetId }) => {
            const { findChat } = await import("/src/ts/storage/chatStore.svelte.ts");
            return findChat({ chaId, chatId: "c" }).message.find((m) => m.chatId === targetId).data;
        },
        { chaId, targetId: id(target) },
    );
    assert.equal(stored, expectedText);
    check(
        "textarea fits wholly inside the transcript",
        open.areaH > 0 && open.areaTop >= 0 && open.areaTop + open.areaH <= open.view,
        true,
    );
    if (name !== "short") check("stable textarea height", open.areaH, 256);
    if (["newest", "newest-settled-only", "save", "save-clamped", "reader-scrolled", "bottom"].includes(name))
        within("newest editor opens at the bottom", open.scrollTop, 0, 1);
    if (name === "short" || name === "bottom") {
        within("open keeps transcript offset", open.scrollTop, before.scrollTop, 1);
        within("close keeps transcript offset", closed.scrollTop, before.scrollTop, 1);
    }
    if (name === "save") {
        check("saved text changes row height", closed.rowH > before.rowH, true);
        within("save restores the row top", closed.rowTop, before.rowTop);
    } else if (name === "save-clamped") {
        check("the shortened row cannot reach its original top", closed.rowTop > before.rowTop + 2, true);
        within("save reaches the end of the available scroll range", closed.scrollTop, 0, 1);
    } else if (name === "reader-scrolled") {
        check("reader chose a different passage", scrolled.reading !== before.reading, true);
        check("close keeps the reader's chosen passage", closed.reading, scrolled.reading);
        within("close keeps the reader's chosen passage offset", closed.readingY, scrolled.readingY);
    } else {
        check("cancel restores top passage", closed.reading, before.reading);
        within("cancel restores the passage offset", closed.readingY, before.readingY);
    }
}

const stack = await startStack({
    serverPort: Number(process.env.SCROLL_SERVER_PORT ?? 6331),
    vitePort: Number(process.env.SCROLL_VITE_PORT ?? 5431),
    log: process.env.DEBUG ? (s) => process.stderr.write(s) : undefined,
});
let browser;
try {
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await isolateContext(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.error(error));
    console.log(JSON.stringify({ step: "browser", version: browser.version(), viewport: page.viewportSize() }));
    await seed(page, stack);
    for (const scenario of scenarios) await run(page, scenario);
} finally {
    try {
        await browser?.close();
    } finally {
        await stack.stop();
    }
}
